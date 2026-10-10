/**
 * click-copy: click a fenced code block to copy it, exactly.
 *
 * Why: pi-tui hard-wraps long lines into physical terminal rows, so
 * triple-click line selection copies wrap-induced fragments — and
 * wrapping in copied drafts (Slack messages etc.) is actively harmful.
 * This bypasses selection entirely: in Pi's fullscreen TUI mode, click
 * any code block and its exact original text is copied — one block, no
 * padding, no wrap-induced line breaks.
 *
 * Copying uses Pi's copyToClipboard(): native pbcopy on macOS, OSC 52
 * over SSH.
 *
 * md-fence-render maps rendered rows to code blocks and claims
 * press/click in its fullscreen handleMouse, routing the exact source
 * through the click hook exposed here by symbol.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";

interface ClickedBlock {
	lang: string;
	code: string;
	setCopied?: (copied: boolean) => void;
}

const CLICK_COPY = Symbol.for("pi-kit:click-copy:click");
const FEEDBACK_STATUS = "click-copy-render";
const FEEDBACK_MS = 1_500;

export default function clickCopy(pi: ExtensionAPI) {
	registerLoadedExtension("click-copy");
	let activeCtx: any;
	let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
	let clearFeedback: (() => void) | undefined;
	let request = 0;

	function requestRender() {
		// Clearing an absent status is a public, display-neutral way to ask Pi's
		// active TUI to render. It also works while a taken-over session visits
		// another agent, where that agent's Markdown is outside the main chat.
		activeCtx?.ui?.setStatus?.(FEEDBACK_STATUS, undefined);
	}

	function resetFeedback() {
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedbackTimer = undefined;
		clearFeedback?.();
		clearFeedback = undefined;
	}

	function showFeedback(block: ClickedBlock) {
		resetFeedback();
		if (!block.setCopied) return;
		block.setCopied(true);
		clearFeedback = () => block.setCopied?.(false);
		requestRender();
		feedbackTimer = setTimeout(() => {
			resetFeedback();
			requestRender();
		}, FEEDBACK_MS);
	}

	async function copyCode(block: ClickedBlock, copyRequest: number) {
		try {
			await copyToClipboard(block.code);
			if (copyRequest === request) showFeedback(block);
		} catch (err: any) {
			if (copyRequest !== request) return;
			activeCtx?.ui?.notify?.(
				`Copy failed: ${err?.message ?? String(err)}`,
				"error",
			);
		}
	}

	(globalThis as any)[CLICK_COPY] = (block: ClickedBlock) => {
		void copyCode(block, ++request);
	};

	// Keep the UI context fresh across sessions/reloads.
	pi.on("session_start", (_event, ctx?: any) => {
		resetFeedback();
		activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		request++;
		resetFeedback();
		activeCtx = undefined;
	});
}
