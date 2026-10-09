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
}

const CLICK_COPY = Symbol.for("pi-kit:click-copy:click");

export default function clickCopy(pi: ExtensionAPI) {
	registerLoadedExtension("click-copy");
	let activeCtx: any;

	async function copyCode(code: string, lang: string) {
		try {
			await copyToClipboard(code);
			const n = code.split("\n").length;
			activeCtx?.ui?.notify?.(
				`Copied${lang ? ` (${lang})` : ""} — ${n} line${n === 1 ? "" : "s"}`,
				"info",
			);
		} catch (err: any) {
			activeCtx?.ui?.notify?.(
				`Copy failed: ${err?.message ?? String(err)}`,
				"error",
			);
		}
	}

	(globalThis as any)[CLICK_COPY] = (block: ClickedBlock) => {
		void copyCode(block.code, block.lang);
	};

	// Keep the notify context fresh across sessions/reloads.
	pi.on("session_start", (_event, ctx?: any) => {
		activeCtx = ctx;
	});
}
