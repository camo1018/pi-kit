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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DIVIDER_MD = "\n---\n**▼ FINAL ANSWER**\n\n";

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

export default function finalAnswerDivider(pi: ExtensionAPI) {
	// Restore markers for historical messages when a session is started/loaded/reloaded,
	// since message_end won't re-fire for them. Only the current branch is inspected
	// (abandoned branches are alternative histories).
	pi.on("session_start", (_event: unknown, ctx?: { sessionManager?: SessionManagerLike }) => {
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
}
