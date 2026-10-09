/**
 * snippet-copy: copy fenced code blocks exactly, without mouse selection.
 *
 * Why: pi-tui hard-wraps long lines into physical terminal rows, so
 * triple-click line selection copies wrap-induced fragments — and the
 * 80-column copy-safe guideline means even prose like Slack drafts
 * contains real line breaks. This bypasses selection entirely:
 *
 *   - Every fenced block in an assistant message gets a numbered label
 *     under it: `⧉ #3 · /cc 3` (display-only; the session transcript
 *     and model context keep the raw text).
 *   - /cc            copy the most recent block
 *   - /cc <n>        copy block #n (completions preview contents)
 *   - /cc <lang>     copy the most recent block with that language,
 *                    e.g. /cc text for the latest Slack draft
 *   - ctrl+shift+y   copy the most recent block
 *
 * Click-to-copy lives in click-copy; when both are loaded, a click
 * copies without touching the numbering here.
 *
 * Copying uses Pi's copyToClipboard(): native pbcopy on macOS, OSC 52
 * over SSH — the exact original text, one block, no padding, no
 * wrap-induced line breaks.
 *
 * Click-to-copy lives in the separate click-copy extension; when both
 * are loaded, a click copies without touching the numbering here.
 *
 * Load order: registered before md-fence-render (transformers chain in
 * package order), so labels attach to the raw markdown and survive
 * fence rewriting; rendered ```md blocks keep their labels, and code
 * blocks nested inside them get numbered too.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";

/** Fence info strings md-fence-render renders as Markdown. Keep in sync
 * with extensions/md-fence-render/index.ts RENDER_LANGS. */
const RENDER_LANGS = new Set(["markdown", "md"]);

interface Block {
	id: number;
	lang: string;
	code: string;
}

/** All code blocks seen in assistant messages on the current branch, in order. */
let blocks: Block[] = [];
/** code text -> id (first occurrence wins, so identical blocks share an id). */
let idByCode = new Map<string, number>();

interface Fence {
	lang: string;
	code: string;
	/** index of the closing fence line */
	closeLine: number;
	indent: string;
}

interface OpenFence {
	char: string;
	len: number;
	lang: string;
	indent: string;
	/** index of the opening fence line */
	start: number;
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;

function parseFence(line: string): OpenFence | null {
	const m = FENCE_RE.exec(line);
	if (!m) return null;
	return {
		indent: m[1],
		char: m[2][0],
		len: m[2].length,
		lang: (m[3] ?? "").toLowerCase(),
		start: -1,
	};
}

/** A closing fence: same char, at least as long, nothing else on the line. */
function closes(line: string, f: OpenFence): boolean {
	const t = line.trim();
	return t.length >= f.len && t === f.char.repeat(t.length);
}

/**
 * Scan fenced blocks the way md-fence-render sees them: inside a
 * rendered-markdown block (```md), a fence carrying a lang opens a
 * nested block and a bare fence closes the innermost open block.
 * Nested blocks are emitted before their container (closing order), so
 * `out` is sorted by closeLine — splicing labels bottom-up stays valid.
 */
function scanFences(markdown: string): Fence[] {
	const lines = markdown.split("\n");
	const out: Fence[] = [];
	const stack: OpenFence[] = [];
	for (let i = 0; i < lines.length; i++) {
		const top = stack[stack.length - 1];
		if (!top) {
			const f = parseFence(lines[i]);
			if (f) stack.push({ ...f, start: i });
			continue;
		}
		if (closes(lines[i], top)) {
			stack.pop();
			const body = lines
				.slice(top.start + 1, i)
				.map((l) =>
					top.indent && l.startsWith(top.indent) ? l.slice(top.indent.length) : l,
				)
				.join("\n");
			out.push({ lang: top.lang, code: body, closeLine: i, indent: top.indent });
			continue;
		}
		if (RENDER_LANGS.has(top.lang)) {
			const f = parseFence(lines[i]);
			if (f && f.lang) {
				stack.push({ ...f, start: i });
				continue;
			}
		}
	}
	return out;
}

/** Assign a stable id to a block's code text; returns 0 for empty blocks. */
function register(lang: string, code: string): number {
	if (!code.trim()) return 0;
	let id = idByCode.get(code);
	if (!id) {
		id = blocks.length + 1;
		blocks.push({ id, lang, code });
		idByCode.set(code, id);
	}
	return id;
}

function textOf(message: any): string[] {
	if (!message || message.role !== "assistant") return [];
	const c = message.content;
	if (typeof c === "string") return [c];
	if (!Array.isArray(c)) return [];
	return c
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text);
}

/** Remember every fenced block of an assistant message. */
function remember(message: any) {
	for (const text of textOf(message)) {
		for (const f of scanFences(text)) register(f.lang, f.code);
	}
}

function reset() {
	blocks = [];
	idByCode = new Map();
}

function preview(code: string, max = 60): string {
	const first = code.split("\n").find((l) => l.trim()) ?? "";
	const s = first.trim();
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

async function copyCode(
	code: string,
	lang: string,
	ctx: any,
	id?: number,
) {
	try {
		await copyToClipboard(code);
		const n = code.split("\n").length;
		const which = id ? ` #${id}` : "";
		ctx?.ui?.notify?.(
			`Copied${which}${lang ? ` (${lang})` : ""} — ` +
				`${n} line${n === 1 ? "" : "s"}`,
			"info",
		);
	} catch (err: any) {
		ctx?.ui?.notify?.(
			`Copy failed: ${err?.message ?? String(err)}`,
			"error",
		);
	}
}

async function copyBlock(b: Block | undefined, ctx: any) {
	if (!b) {
		ctx?.ui?.notify?.("No code block to copy", "warning");
		return;
	}
	return copyCode(b.code, b.lang, ctx, b.id);
}

export default function snippetCopy(pi: ExtensionAPI) {
	registerLoadedExtension("snippet-copy");

	pi.on("session_start", (_event, ctx?: any) => {
		reset();
		try {
			for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
				if (entry?.type === "message") remember(entry.message);
			}
		} catch {
			// best-effort; new messages repopulate
		}
	});

	pi.on("message_end", (event) => remember(event?.message));

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant" || context.isStreaming) {
			return markdown;
		}
		const fences = scanFences(markdown);
		if (!fences.length) return markdown;
		const lines = markdown.split("\n");
		// insert bottom-up so earlier indices stay valid; ids come from
		// remember() (forward scan order) so numbering follows visual order
		for (const f of [...fences].reverse()) {
			const id = idByCode.get(f.code);
			if (!id) continue;
			lines.splice(f.closeLine + 1, 0, `${f.indent}*⧉ #${id} · \`/cc ${id}\`*`);
		}
		return lines.join("\n");
	});

	pi.registerCommand("cc", {
		description:
			"Copy a code block to the clipboard (default: latest; " +
			"/cc <n> by number; /cc <lang> e.g. /cc text for the latest draft",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase().replace(/^#/, "");
			const items = [...blocks]
				.reverse()
				.filter((b) => {
					if (!p) return true;
					if (/^\d+$/.test(p)) return String(b.id).startsWith(p);
					return b.lang.toLowerCase().startsWith(p);
				})
				.slice(0, 20)
				.map((b) => ({
					value: String(b.id),
					label: `#${b.id}${b.lang ? ` ${b.lang}` : ""}`,
					description: preview(b.code),
				}));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim().replace(/^#/, "");
			if (!arg) return copyBlock(blocks[blocks.length - 1], ctx);
			if (/^\d+$/.test(arg)) {
				const id = Number.parseInt(arg, 10);
				return copyBlock(blocks.find((b) => b.id === id), ctx);
			}
			// language prefix: copy the most recent block whose lang matches
			const p = arg.toLowerCase();
			const matches = blocks.filter((b) => b.lang.toLowerCase().startsWith(p));
			if (!matches.length) {
				ctx?.ui?.notify?.(
					`No code block with language starting "${p}"`,
					"warning",
				);
				return;
			}
			const b = matches[matches.length - 1];
			if (matches.length > 1) {
				ctx?.ui?.notify?.(
					`${matches.length} "${p}" blocks — copying latest (#${b.id})`,
					"info",
				);
			}
			return copyBlock(b, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+y", {
		description: "Copy the latest code block",
		handler: (ctx) => copyBlock(blocks[blocks.length - 1], ctx),
	});
}
