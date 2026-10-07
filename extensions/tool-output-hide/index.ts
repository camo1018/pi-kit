/**
 * Tool Output Hide Extension for Pi
 *
 * Adds a third state to ctrl+o (`app.tools.expand`). Pressing it now cycles:
 *
 *   collapsed  →  expanded  →  hidden  →  collapsed …
 *
 * "hidden" removes tool-call blocks (call line + output) from the transcript
 * entirely. Nothing is lost: it's display-only, the session and model context
 * are untouched, and switching back re-shows every block. While hidden, the
 * footer shows a `tools hidden` badge so the state is obvious.
 *
 *   /tools                       cycle like ctrl+o
 *   /tools collapsed|expanded|hidden   jump to a state
 *
 * How it works (pi has no public hook for this, so it patches two prototypes
 * from the bundled pi-coding-agent module — the same instances interactive
 * mode uses):
 *   - ToolExecutionComponent.render() returns [] while hidden.
 *   - CustomEditor.handleInput() intercepts the `app.tools.expand` key so the
 *     cycle replaces the built-in toggle. Only the main editor is affected;
 *     pickers that reuse ctrl+o (e.g. /tree filter cycling) keep working.
 * Patches are installed once per process and read live state from globalThis,
 * so /reload just swaps the handler instead of double-wrapping.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

type Mode = "collapsed" | "expanded" | "hidden";
const MODES: Mode[] = ["collapsed", "expanded", "hidden"];
const STATUS_KEY = "tool-output-hide";

interface SharedState {
	hidden: boolean;
	/** Set by the currently loaded extension instance; called on ctrl+o. */
	cycle?: () => void;
	patched?: boolean;
}

const STATE_KEY = Symbol.for("pi.ext.tool-output-hide");
const g = globalThis as unknown as Record<symbol, SharedState | undefined>;
const state: SharedState = (g[STATE_KEY] ??= { hidden: false });

function installPatches(): void {
	if (state.patched) return;
	state.patched = true;

	const toolProto = ToolExecutionComponent.prototype as unknown as { render(width: number): string[] };
	const origRender = toolProto.render;
	toolProto.render = function (this: unknown, width: number): string[] {
		if (state.hidden) return [];
		return origRender.call(this, width);
	};

	type EditorLike = {
		keybindings?: { matches(data: string, action: string): boolean };
		actionHandlers?: Map<string, () => void>;
		handleInput(data: string): void;
	};
	const editorProto = CustomEditor.prototype as unknown as EditorLike;
	const origHandleInput = editorProto.handleInput;
	editorProto.handleInput = function (this: EditorLike, data: string): void {
		// Only hijack editors wired up by interactive mode (they carry the
		// built-in app.tools.expand handler) and only when we have a live ctx.
		if (
			state.cycle &&
			this.actionHandlers?.has("app.tools.expand") &&
			this.keybindings?.matches(data, "app.tools.expand")
		) {
			state.cycle();
			return;
		}
		origHandleInput.call(this, data);
	};
}

export default function (pi: ExtensionAPI) {
	installPatches();

	let ctx: ExtensionContext | undefined;

	const currentMode = (c: ExtensionContext): Mode =>
		state.hidden ? "hidden" : c.ui.getToolsExpanded() ? "expanded" : "collapsed";

	const apply = (c: ExtensionContext, mode: Mode): void => {
		state.hidden = mode === "hidden";
		// Hidden blocks are kept collapsed so un-hiding lands on the compact view.
		c.ui.setToolsExpanded(mode === "expanded");
		c.ui.setStatus(STATUS_KEY, state.hidden ? c.ui.theme.fg("warning", "tools hidden") : undefined);
		// Info notify reuses pi's in-place status line, replacing the built-in
		// "Tool output: collapsed" message and forcing a re-render.
		c.ui.notify(`Tool output: ${mode}`, "info");
	};

	const cycle = (c: ExtensionContext): void => {
		const next = MODES[(MODES.indexOf(currentMode(c)) + 1) % MODES.length];
		apply(c, next);
	};

	pi.on("session_start", async (_event, c) => {
		if (c.mode !== "tui") return;
		ctx = c;
		state.cycle = () => ctx && cycle(ctx);
		// Restore the footer badge after /reload or session switch.
		c.ui.setStatus(STATUS_KEY, state.hidden ? c.ui.theme.fg("warning", "tools hidden") : undefined);
	});

	pi.on("session_shutdown", async () => {
		ctx = undefined;
		state.cycle = undefined;
	});

	pi.registerCommand("tools", {
		description: "Tool output display: cycle, or set collapsed | expanded | hidden",
		getArgumentCompletions: (prefix: string) =>
			MODES.filter((m) => m.startsWith(prefix.trim())).map((m) => ({ value: m, label: m })),
		handler: async (args, c) => {
			if (c.mode !== "tui") return;
			const arg = args.trim().toLowerCase();
			if (!arg) return cycle(c);
			const mode = MODES.find((m) => m.startsWith(arg));
			if (!mode) {
				c.ui.notify(`Unknown mode "${arg}". Use: ${MODES.join(", ")}`, "warning");
				return;
			}
			apply(c, mode);
		},
	});
}
