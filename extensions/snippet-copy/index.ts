/**
 * Snippet Copy Extension for Pi
 *
 * Makes every fenced code block in assistant replies copyable without mouse
 * selection (which picks up TUI padding / wrapping and breaks Python indents).
 *
 *   - Each code block gets a numbered label under it: `⧉ #3 · /cc 3`
 *     (presentation only — session transcript and model context untouched).
 *   - `ctrl+shift+y` copy the most recent code block
 *   - `/cc`          copy the most recent code block
 *   - `/cc <n>`      copy block #n (autocomplete shows previews)
 *
 * Copies the exact original text via Pi's copyToClipboard(): pbcopy locally,
 * OSC 52 over SSH (works from a Coder dev space into the Mac clipboard when
 * iTerm2 → Settings → General → Selection → "Applications in terminal may
 * access clipboard" is enabled).
 *
 * File is named `snippet-copy.ts` so it loads after final-answer-divider.ts:
 * markdown transformers chain in load order and the divider matches on the
 * untransformed text.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

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

/** Minimal CommonMark-ish fenced block scanner (``` or ~~~, indent ≤ 3). */
function scanFences(markdown: string): Fence[] {
	const lines = markdown.split("\n");
	const out: Fence[] = [];
	let i = 0;
	while (i < lines.length) {
		const open = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/.exec(lines[i]);
		if (!open) {
			i++;
			continue;
		}
		const [, indent, fence, lang] = open;
		const closeRe = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
		let j = i + 1;
		while (j < lines.length && !closeRe.test(lines[j])) j++;
		if (j >= lines.length) break; // unterminated (still streaming) — ignore
		const body = lines
			.slice(i + 1, j)
			.map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l))
			.join("\n");
		out.push({ lang: lang || "", code: body, closeLine: j, indent });
		i = j + 1;
	}
	return out;
}

function textOf(message: any): string[] {
	if (!message || message.role !== "assistant") return [];
	const c = message.content;
	if (typeof c === "string") return [c];
	if (!Array.isArray(c)) return [];
	return c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text);
}

function remember(message: any) {
	for (const text of textOf(message)) {
		for (const f of scanFences(text)) {
			if (!f.code.trim() || idByCode.has(f.code)) continue;
			const id = blocks.length + 1;
			blocks.push({ id, lang: f.lang, code: f.code });
			idByCode.set(f.code, id);
		}
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

async function copyBlock(b: Block | undefined, ctx: any) {
	if (!b) {
		ctx?.ui?.notify?.("No code block to copy", "warning");
		return;
	}
	try {
		await copyToClipboard(b.code);
		const n = b.code.split("\n").length;
		ctx?.ui?.notify?.(`Copied #${b.id}${b.lang ? ` (${b.lang})` : ""} — ${n} line${n === 1 ? "" : "s"}`, "info");
	} catch (err: any) {
		ctx?.ui?.notify?.(`Copy failed: ${err?.message ?? String(err)}`, "error");
	}
}

export default function snippetCopy(pi: ExtensionAPI) {
	pi.on("session_start", (_event: unknown, ctx?: any) => {
		reset();
		try {
			for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
				if (entry?.type === "message") remember(entry.message);
			}
		} catch {
			// best-effort; new messages repopulate
		}
	});

	pi.on("message_end", (event: { message?: any }) => remember(event?.message));

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant" || context.isStreaming) return markdown;
		const fences = scanFences(markdown);
		if (!fences.length) return markdown;
		const lines = markdown.split("\n");
		// insert bottom-up so earlier indices stay valid
		for (const f of [...fences].reverse()) {
			const id = idByCode.get(f.code);
			if (!id) continue;
			lines.splice(f.closeLine + 1, 0, `${f.indent}*⧉ #${id} · \`/cc ${id}\` or ctrl+shift+y for latest*`);
		}
		return lines.join("\n");
	});

	pi.registerCommand("cc", {
		description: "Copy a code block from the conversation (default: latest; /cc <n> for block #n)",
		getArgumentCompletions: (prefix: string) => {
			const items = [...blocks]
				.reverse()
				.filter((b) => String(b.id).startsWith(prefix.trim()))
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
			const n = Number.parseInt(arg, 10);
			if (!Number.isFinite(n)) {
				ctx?.ui?.notify?.(`Usage: /cc [n]  (1–${blocks.length})`, "warning");
				return;
			}
			return copyBlock(blocks[n - 1], ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+y", {
		description: "Copy the latest code block",
		handler: (ctx) => copyBlock(blocks[blocks.length - 1], ctx),
	});
}
