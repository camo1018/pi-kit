/**
 * command-case: slash commands ignore caps-lock casing.
 *
 * Pi matches slash commands case-sensitively in three places:
 *   1. builtins, via exact compares (text === "/reload") in
 *      InteractiveMode.setupEditorSubmitHandler(),
 *   2. extension commands, via getCommand(name) which finds on
 *      invocationName === name,
 *   3. /skill: expansion, via skills.find(s => s.name === name).
 * A caps-lock "/RELOAD" therefore matches nothing and silently falls
 * through to the LLM as a literal prompt.
 *
 * Fix: wrap the editor's submit path so that when the first token of a
 * submitted input looks like a slash command ("/RELOAD", "/MODEL X"),
 * its name is canonicalized against the set of real commands (builtins
 * + everything pi.getCommands() reports: extension, prompt-template,
 * and skill commands). If the lowercased name matches, submit with the
 * canonical casing; otherwise pass the text through untouched so
 * unknown "/commands" still reach the model as typed.
 *
 * Only the command name is rewritten; arguments keep their casing
 * (e.g. "/NAME Foo" -> "/name Foo").
 *
 * Implementation: CustomEditor subclass installed via the documented
 * ctx.ui.setEditorComponent() API. The factory runs inside pi's own
 * module realm, but pi wires submit behavior onto whatever editor it
 * gets by plain property assignment (newEditor.onSubmit = ...), and it
 * re-assigns onSubmit on every /reload (resetExtensionUI ->
 * setCustomEditorComponent(undefined), then session_start re-installs
 * ours). So we define the interposition as an own property in the
 * constructor: an intercepting setter that wraps whatever handler pi
 * assigns, plus a getter that hands back the wrapper. pi's copy of
 * actionHandlers/onEscape/etc. is preserved by its duck-typing branch.
 *
 * Submit paths covered:
 *   - Enter submit: pi-tui Editor.submitValue() reads this.onSubmit
 *     (our wrapper) after clearing state, so the LLM never sees the
 *     raw casing.
 *   - Alt+Enter followUp while streaming: InteractiveMode
 *     .handleFollowUp() reads editor.getExpandedText() directly, so we
 *     also override getExpandedText() to canonicalize.
 *   - Editor history: pi calls addToHistory with the text it sees; we
 *     rewrite before pi records it, so history stores the canonical
 *     form (matches autocomplete behavior).
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";

/**
 * Builtin commands handled by InteractiveMode (the ones matched by
 * exact string compares before extensions ever see the input).
 * Keep in sync with BUILTIN_SLASH_COMMANDS in pi's slash-commands.ts.
 */
const BUILTIN_COMMANDS = new Set([
	"settings",
	"model",
	"tree",
	"thinking",
	"scoped-models",
	"export",
	"import",
	"share",
	"bug",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
	// Handled alongside builtins in setupEditorSubmitHandler but not
	// listed in BUILTIN_SLASH_COMMANDS:
	"debug",
	"arminsayshi",
	"dementedelves",
]);

/** Canonical casing for every command name, lowercase -> original. */
let canonical: Map<string, string> | undefined;
let getCommands: (() => SlashCommandInfo[]) | undefined;

function refreshCommands(ctx: ExtensionContext): void {
	getCommands = () => ctx.getCommands();
	canonical = undefined; // invalidate; rebuilt lazily
}

/**
 * Return the canonical form of a command name, or undefined when no
 * command (builtin, extension, prompt template, or skill) matches the
 * lowercased name.
 */
function canonicalName(name: string): string | undefined {
	if (canonical === undefined) {
		canonical = new Map<string, string>();
		for (const name of BUILTIN_COMMANDS) canonical.set(name, name);
		if (getCommands) {
			for (const command of getCommands()) {
				// First registration wins, matching pi's dispatch order.
				if (!canonical.has(command.name.toLowerCase())) {
					canonical.set(command.name.toLowerCase(), command.name);
				}
			}
		}
	}
	return canonical.get(name.toLowerCase());
}

/**
 * Canonicalize a slash-command-looking first line of `text`.
 * Returns the original string unless the first token starts with "/",
 * has a command-name-shaped remainder, and that name (lowercased)
 * matches a real command.
 *
 * Multi-line input: only the first line can be a command (pi's
 * handlers dispatch on the whole submitted string; a first-line
 * command with further lines is not a command dispatch at all, so we
 * leave any other shape alone).
 */
export function canonicalizeCommandText(text: string): string {
	if (!text.startsWith("/")) return text;
	const firstNewline = text.indexOf("\n");
	const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
	const rest = firstNewline === -1 ? "" : text.slice(firstNewline);
	const spaceIndex = firstLine.indexOf(" ");
	const rawName = spaceIndex === -1 ? firstLine.slice(1) : firstLine.slice(1, spaceIndex);
	if (!rawName) return text;
	// Command names never contain whitespace or slashes; anything else
	// (URLs like "//host/path", file paths) is left untouched.
	if (/[^a-zA-Z0-9:_-]/.test(rawName)) return text;
	const name = canonicalName(rawName);
	if (name === undefined || name === rawName) return text;
	const rebuilt =
		spaceIndex === -1
			? `/${name}`
			: `/${name}${firstLine.slice(spaceIndex)}`;
	return rebuilt + rest;
}

class CaseInsensitiveCommandEditor extends CustomEditor {
	private originalSubmit?: (text: string) => void;

	constructor(...args: any[]) {
		// @ts-expect-error - spread into CustomEditor's typed constructor
		super(...args);
		const self = this;
		// Own property shadows pi-tui's prototype field so that pi's plain
		// assignment (`newEditor.onSubmit = handler`) stores the raw handler
		// here, while every read (Editor.submitValue: this.onSubmit(text))
		// hands back a canonicalizing wrapper. On /reload pi tears the custom
		// editor down before session_start re-installs this factory, so the
		// setter always sees a fresh instance and never double-wraps.
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			get() {
				const handler = self.originalSubmit;
				if (!handler) return undefined;
				return (text: string) => handler(canonicalizeCommandText(text));
			},
			set(handler) {
				self.originalSubmit = handler;
			},
		});
	}

	/**
	 * Alt+Enter while streaming: InteractiveMode.handleFollowUp() reads
	 * the expanded text directly instead of going through onSubmit, so
	 * canonicalize there too. The state has already been cleared when
	 * this is called from submitValue() (which then invokes onSubmit) —
	 * but handleFollowUp() clears it after reading, so text is intact.
	 */
	getExpandedText(): string {
		return canonicalizeCommandText(super.getExpandedText());
	}
}

export default function commandCase(pi: ExtensionAPI) {
	registerLoadedExtension("command-case");
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		refreshCommands(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new CaseInsensitiveCommandEditor(tui, theme, keybindings, { embedWorkingStatus: true }),
		);
	});
}
