/**
 * Thinking Block Hide Extension for Pi
 *
 * Adds a third display state to ctrl+t (`app.thinking.toggle`):
 *
 *   visible  →  collapsed  →  hidden  →  visible …
 *
 * Pi's native collapsed state renders `Thinking...`. The hidden state removes
 * thinking blocks from the transcript entirely. This is display-only: session
 * history and model context are unchanged. The selected mode is persisted in
 * ~/.pi/agent/thinking-block-visibility.json.
 *
 *   /thinking-blocks
 *   /thinking-blocks visible|collapsed|hidden
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomEditor,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";

type Mode = "visible" | "collapsed" | "hidden";
const MODES: Mode[] = ["visible", "collapsed", "hidden"];
const STATUS_KEY = "thinking-block-hide";
const STATE_FILE = path.join(
	getAgentDir(),
	"thinking-block-visibility.json",
);

interface SharedState {
	mode: Mode;
	loaded?: boolean;
	patched?: boolean;
	cycle?: () => void;
}

const STATE_KEY = Symbol.for("pi.ext.thinking-block-hide");
const globals = globalThis as unknown as Record<
	symbol,
	SharedState | undefined
>;
const state: SharedState = (globals[STATE_KEY] ??= {
	mode: "collapsed",
});

function isMode(value: unknown): value is Mode {
	return typeof value === "string" && MODES.includes(value as Mode);
}

function readMode(cwd: string): Mode {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		if (isMode(parsed?.mode)) return parsed.mode;
	} catch {
		// No extension setting yet. Fall back to Pi's native boolean.
	}
	return SettingsManager.create(cwd).getHideThinkingBlock()
		? "collapsed"
		: "visible";
}

function writeMode(mode: Mode): void {
	fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
	fs.writeFileSync(
		STATE_FILE,
		`${JSON.stringify({ mode }, null, 2)}\n`,
	);
}

function syncNativeSetting(cwd: string, mode: Mode): void {
	const settings = SettingsManager.create(cwd);
	settings.setHideThinkingBlock(mode !== "visible");
	void settings.flush().catch(() => {
		// Pi will report settings write errors through its own settings manager.
	});
}

function withoutThinking(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.filter(
			(part) => part.type !== "thinking",
		),
	};
}

function installPatches(): void {
	if (state.patched) return;
	state.patched = true;

	type AssistantLike = {
		hideThinkingBlock: boolean;
		isStreaming: boolean;
		lastMessage?: AssistantMessage;
		thinkingVisibilityOverrides?: Map<number, boolean>;
	};
	type AssistantPrototype = AssistantLike & {
		updateContent(
			message: AssistantMessage,
			isStreaming?: boolean,
		): void;
		render(width: number): string[];
	};

	const assistantProto = AssistantMessageComponent.prototype as unknown as
		AssistantPrototype;
	const originalUpdate = assistantProto.updateContent;
	const originalRender = assistantProto.render;
	const messages = new WeakMap<object, AssistantMessage>();
	const modes = new WeakMap<object, Mode>();

	const rebuild = (
		component: AssistantLike,
		message: AssistantMessage,
		isStreaming: boolean,
	): void => {
		component.hideThinkingBlock = state.mode !== "visible";
		originalUpdate.call(
			component,
			state.mode === "hidden" ? withoutThinking(message) : message,
			isStreaming,
		);
		component.lastMessage = message;
	};

	assistantProto.updateContent = function (
		this: AssistantLike,
		message: AssistantMessage,
		isStreaming = this.isStreaming,
	): void {
		if (modes.get(this) !== state.mode) {
			this.thinkingVisibilityOverrides?.clear();
		}
		messages.set(this, message);
		modes.set(this, state.mode);
		rebuild(this, message, isStreaming);
	};

	assistantProto.render = function (
		this: AssistantLike,
		width: number,
	): string[] {
		const message = messages.get(this) ?? this.lastMessage;
		if (message && modes.get(this) !== state.mode) {
			this.thinkingVisibilityOverrides?.clear();
			modes.set(this, state.mode);
			rebuild(this, message, this.isStreaming);
		}
		return originalRender.call(this, width);
	};

	type EditorLike = {
		keybindings?: {
			matches(data: string, action: string): boolean;
		};
		actionHandlers?: Map<string, () => void>;
		handleInput(data: string): void;
	};
	const editorProto = CustomEditor.prototype as unknown as EditorLike;
	const originalHandleInput = editorProto.handleInput;
	editorProto.handleInput = function (
		this: EditorLike,
		data: string,
	): void {
		if (
			state.cycle &&
			this.actionHandlers?.has("app.thinking.toggle") &&
			this.keybindings?.matches(data, "app.thinking.toggle")
		) {
			state.cycle();
			return;
		}
		originalHandleInput.call(this, data);
	};
}

export default function thinkingBlockHide(pi: ExtensionAPI) {
	registerLoadedExtension("thinking-block-hide");
	installPatches();

	let ctx: ExtensionContext | undefined;

	const refresh = (current: ExtensionContext): void => {
		current.ui.setHiddenThinkingLabel(
			state.mode === "hidden" ? "" : undefined,
		);
		current.ui.setStatus(
			STATUS_KEY,
			state.mode === "hidden"
				? current.ui.theme.fg("warning", "thinking hidden")
				: undefined,
		);
	};

	const apply = (
		current: ExtensionContext,
		mode: Mode,
		notify = true,
	): void => {
		state.mode = mode;
		writeMode(mode);
		syncNativeSetting(current.cwd, mode);
		refresh(current);
		if (notify) {
			current.ui.notify(`Thinking blocks: ${mode}`, "info");
		}
	};

	const cycle = (current: ExtensionContext): void => {
		const index = MODES.indexOf(state.mode);
		apply(current, MODES[(index + 1) % MODES.length]);
	};

	pi.on("session_start", async (_event, current) => {
		if (current.mode !== "tui") return;
		ctx = current;
		if (!state.loaded) {
			state.mode = readMode(current.cwd);
			state.loaded = true;
		}
		state.cycle = () => ctx && cycle(ctx);
		refresh(current);
	});

	pi.on("session_shutdown", async () => {
		ctx = undefined;
		state.cycle = undefined;
	});

	pi.registerCommand("thinking-blocks", {
		description:
			"Thinking display: cycle, or set visible | collapsed | hidden",
		getArgumentCompletions: (prefix: string) =>
			MODES.filter((mode) => mode.startsWith(prefix.trim())).map(
				(mode) => ({ value: mode, label: mode }),
			),
		handler: async (args, current) => {
			if (current.mode !== "tui") return;
			const arg = args.trim().toLowerCase();
			if (!arg) return cycle(current);
			const mode = MODES.find((value) => value.startsWith(arg));
			if (!mode) {
				current.ui.notify(
					`Unknown mode "${arg}". Use: ${MODES.join(", ")}`,
					"warning",
				);
				return;
			}
			apply(current, mode);
		},
	});
}
