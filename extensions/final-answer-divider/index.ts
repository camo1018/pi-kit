/**
 * Final Answer Divider Extension for Pi
 *
 * Deterministically renders a visible divider marking where the agent's
 * FINAL response begins — the boundary between the last tool/reasoning
 * activity and the concluding assistant message. Implemented entirely in
 * the harness: zero prompt tokens, zero reliance on the model following
 * formatting instructions, no effect on the session transcript, model
 * context, or JSON/RPC output.
 *
 * How it works:
 *   - The `message_end` event fires for every finalized assistant message,
 *     BEFORE the TUI re-renders it. The message itself carries the complete
 *     deterministic signal: `stopReason === "stop"` (model finished, not
 *     toolUse/length/error/aborted) and no `toolCall` content blocks.
 *     That message is, by definition, the run's final answer.
 *   - `registerMarkdownTransformer` prepends divider markdown to that
 *     message's first text block when the TUI renders it (isStreaming=false).
 *     It is presentation-only: the session file and LLM context are untouched.
 *   - The first text block of each final answer is remembered so the
 *     divider survives TUI re-renders (resize, theme change, tree nav).
 *
 * It also navigates to that divider (the scroll-bookmark idea from
 * `bookmark.ts`, applied to a structural landmark instead of a saved row):
 * `ctrl+f` or `/final` scrolls the transcript so the LAST final answer sits at
 * the top of the viewport. It always targets that same one; it does not cycle
 * through earlier answers. Finding rows means reading the already-rendered
 * transcript lines, so this needs fullscreen TUI mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";

/** The divider's heading text, as rendered (see DIVIDER_MD). */
export const FINAL_ANSWER_MARKER = "▼ FINAL ANSWER";

const DIVIDER_MD = `\n---\n**${FINAL_ANSWER_MARKER}**\n\n`;

/** First text block (trimmed) of each detected final answer. */
const finalAnswerFirstTexts = new Set<string>();

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

interface AssistantMessageShape {
	role?: string;
	stopReason?: string;
	content?: ContentBlock[] | string;
}

function isFinalAssistantMessage(message: AssistantMessageShape | undefined): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason !== "stop") return false;
	if (!Array.isArray(message.content)) return false;
	const hasToolCall = message.content.some((block) => block?.type === "toolCall");
	const hasText = message.content.some(
		(block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
	);
	return !hasToolCall && hasText;
}

function firstTextBlock(message: AssistantMessageShape): string | undefined {
	if (!Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
			return block.text.trim();
		}
	}
	return undefined;
}

function rememberFinalAnswer(message: AssistantMessageShape | undefined): void {
	if (isFinalAssistantMessage(message)) {
		const firstText = firstTextBlock(message);
		if (firstText !== undefined) {
			finalAnswerFirstTexts.add(firstText);
		}
	}
}

interface SessionManagerLike {
	getBranch?: () => Array<{ type?: string; message?: AssistantMessageShape }>;
}

// ── transcript navigation ────────────────────────────────────────────

/**
 * The slice of pi's fullscreen TUI this needs. All three members are reached
 * for through duck typing: `mode` is public, the rest are pi-tui internals
 * (see the README table and the compat-check probes).
 */
export interface TranscriptViewport {
	mode?: string;
	getPrimaryScrollView?: () => any;
	currentLayout?: any;
	terminal?: { columns: number };
	requestRender?: () => void;
	flash?: (message: string, durationMs?: number) => void;
}

interface ScrollViewLike {
	scrollTop: number;
	getContentWidth?: (width: number) => number;
	child?: { render: (width: number) => string[] };
	scrollTo?: (row: number) => void;
	scrollBy?: (lines: number) => void;
}

/** Indexes of rendered rows carrying the divider heading, top to bottom. */
export function finalAnswerRows(lines: readonly string[]): number[] {
	const rows: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (stripTerminalSequences(lines[i] ?? "").includes(FINAL_ANSWER_MARKER)) rows.push(i);
	}
	return rows;
}

/**
 * Which divider row to reveal: always the newest one in the transcript.
 *
 * Deliberately not a cycle. Pressing again re-reveals the same final answer
 * rather than walking back through history, so the key is idempotent and its
 * meaning does not depend on where the viewport happens to be.
 */
export function lastFinalAnswerRow(rows: readonly number[]): number | undefined {
	return rows.length === 0 ? undefined : rows[rows.length - 1];
}

/** One line of context above the divider, so the heading is not flush at row 0. */
const LEADING_CONTEXT_ROWS = 1;

function primaryScrollView(tui: TranscriptViewport): ScrollViewLike | undefined {
	try {
		return tui.getPrimaryScrollView?.() as ScrollViewLike | undefined;
	} catch {
		return undefined;
	}
}

/**
 * The scroll view's rendered content lines, which is what row indexes hit.
 *
 * The layout frame is preferred over re-rendering the child: `scrollTo()` is
 * clamped to the CONTENT height the last layout pass computed, so measuring
 * from a fresh render would disagree with it mid-stream (or after a resize
 * that has not been painted yet).
 */
export function transcriptLines(tui: TranscriptViewport, scroll: ScrollViewLike): string[] | undefined {
	const find = (box: any): any => {
		if (!box) return undefined;
		if (box.scrollView === scroll && Array.isArray(box.scrollContentLines)) return box;
		for (const child of box.children ?? []) {
			const hit = find(child);
			if (hit) return hit;
		}
		return undefined;
	};
	const fromLayout = find(tui.currentLayout?.root);
	if (fromLayout) return fromLayout.scrollContentLines as string[];
	// No layout yet (nothing painted). Rendering the child is the only option.
	const width = Math.max(1, tui.terminal?.columns ?? 80);
	const contentWidth = scroll.getContentWidth?.(width) ?? width;
	return scroll.child?.render(contentWidth);
}

export type FinalAnswerJump = "ok" | "no-fullscreen" | "no-marker" | "no-viewport";

/** Reveal the last final answer, always the same one on a repeated press. */
export function jumpToFinalAnswer(tui: TranscriptViewport | undefined): FinalAnswerJump {
	if (!tui || tui.mode !== "fullscreen") return "no-fullscreen";
	const scroll = primaryScrollView(tui);
	if (!scroll) return "no-viewport";
	const lines = transcriptLines(tui, scroll);
	if (!lines) return "no-viewport";
	const target = lastFinalAnswerRow(finalAnswerRows(lines));
	if (target === undefined) return "no-marker";
	const row = Math.max(0, target - LEADING_CONTEXT_ROWS);
	if (typeof scroll.scrollTo === "function") scroll.scrollTo(row);
	else scroll.scrollBy?.(row - scroll.scrollTop);
	tui.requestRender?.();
	tui.flash?.("▼ FINAL ANSWER");
	return "ok";
}

const WIDGET_KEY = "final-answer-nav";

/** Zero-height component: registers as a widget only to be handed the TUI. */
function emptyWidget() {
	return { render: () => [] as string[], invalidate: () => {} };
}

// ── extension ────────────────────────────────────────────────────────

export default function finalAnswerDivider(pi: ExtensionAPI) {
	registerLoadedExtension("final-answer-divider");

	let activeTui: TranscriptViewport | undefined;

	/**
	 * pi hands the TUI to widget factories, so an empty widget is the free way
	 * to hold onto it. It renders no lines, and the widget container already
	 * draws a spacer when it is empty, so registering it costs no screen space.
	 */
	function captureTui(ctx: any): TranscriptViewport | undefined {
		if (activeTui) return activeTui;
		try {
			ctx?.ui?.setWidget(WIDGET_KEY, (tui: TranscriptViewport) => {
				activeTui = tui;
				return emptyWidget();
			});
		} catch {
			// No widget support (rpc / json / print): navigation stays unavailable.
		}
		return activeTui;
	}

	function run(ctx: any): void {
		const result = jumpToFinalAnswer(captureTui(ctx));
		if (result === "ok") return;
		const message =
			result === "no-fullscreen"
				? "Final-answer navigation needs fullscreen TUI mode."
				: result === "no-marker"
					? "No FINAL ANSWER in this transcript yet."
					: "Could not read the transcript viewport.";
		ctx?.ui?.notify?.(message, result === "no-marker" ? "info" : "warning");
	}

	// Restore markers for historical messages when a session is started/loaded/reloaded,
	// since message_end won't re-fire for them. Only the current branch is inspected
	// (abandoned branches are alternative histories).
	pi.on("session_start", (_event: unknown, ctx?: { sessionManager?: SessionManagerLike; ui?: unknown }) => {
		// A reload can hand us a new TUI; re-register so navigation follows it.
		activeTui = undefined;
		if (ctx?.ui) captureTui(ctx);
		try {
			const branch = ctx?.sessionManager?.getBranch?.() ?? [];
			for (const entry of branch) {
				if (entry?.type === "message") {
					rememberFinalAnswer(entry.message);
				}
			}
		} catch {
			// Best-effort restoration; fresh runs repopulate markers anyway.
		}
	});

	// Detect the final answer at message_end, before the TUI's finalized render.
	pi.on("message_end", (event: { message?: AssistantMessageShape }) => {
		rememberFinalAnswer(event?.message);
	});

	// Prepend the divider when the TUI renders a final answer's first text block.
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "assistant" && !context.isStreaming && finalAnswerFirstTexts.has(markdown)) {
			return DIVIDER_MD + markdown;
		}
		return markdown;
	});

	// ctrl+f, because it is a single control byte (0x06): it arrives identically
	// under the legacy, xterm modifyOtherKeys, and kitty protocols, so it needs
	// no modifier support from the terminal.
	//
	// This takes over `tui.editor.cursorRight` ("move cursor right", also →).
	// That is safe and deliberate: extension shortcuts are dispatched BEFORE any
	// editor handling (CustomEditor.handleInput), and tui.editor.cursorRight is
	// not in RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS, so the takeover is
	// silent rather than a startup conflict warning. → still moves right one
	// character; only the ctrl+f alias is repurposed.
	pi.registerShortcut("ctrl+f", {
		description: "Scroll to the last FINAL ANSWER",
		handler: (ctx) => run(ctx),
	});

	pi.registerCommand("final", {
		description: "Scroll the transcript to the last FINAL ANSWER",
		handler: async (_args, ctx) => run(ctx),
	});
}
