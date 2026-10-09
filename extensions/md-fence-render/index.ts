/**
 * md-fence-render: render ```markdown / ```md fenced blocks in assistant
 * messages as formatted Markdown instead of a code block.
 *
 * Display-only (registerMarkdownTransformer): the session transcript and
 * model context keep the raw fences.
 *
 * Every other code block keeps Pi's highlight.js syntax highlighting, but the
 * literal ```lang / ``` fence lines are replaced by `┌─ lang` / `└─` (patches
 * Markdown.prototype.renderToken; pi has no public hook for code blocks).
 *
 * Also injects copy-safe code block guidelines into the system prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";

/** Fence info strings that get unwrapped and rendered as Markdown. */
const RENDER_LANGS = new Set(["markdown", "md"]);

/** Block start/end markers. Code blocks use the same glyphs (via codeBlockBorder). */
const OPEN = "┌─";
const CLOSE = "└─";
// Blank lines keep the markers out of the block's first/last paragraph.
const MD_OPEN = [`${OPEN} *rendered markdown*`, ""];
const MD_CLOSE = ["", CLOSE];

/**
 * Copy-safe code block guidelines injected into the system prompt.
 *
 * pi-tui hard-wraps long lines into physical terminal rows, so mouse
 * selection of a wrapped line pastes as several lines. For commands and
 * code, keep lines under 80 columns. For prose meant to be pasted
 * elsewhere (```text drafts like Slack messages), wrapping is actively
 * harmful — the breaks end up in the paste — so keep one sentence or
 * bullet per line and copy via /cc (snippet-copy) instead of selection.
 */
const COPY_GUIDELINES = [
	"In shell and code blocks, keep every line under 80 characters. Break long shell commands with trailing ` \\` continuations (or one flag per line); break long code expressions across lines.",
	"In prose code blocks (```text, e.g. Slack drafts or emails), do NOT hard-wrap at 80 columns — write each sentence, bullet, or paragraph as one long line. Those breaks would end up in the pasted message; the user copies prose blocks with /cc, so long lines are safe.",
	"In shell code blocks, put comments on their own line above the command — never trailing `# ...` after a command on the same line. Don't include prompts like `$ ` or output in runnable blocks.",
	"Don't indent top-level lines of a code block (no leading spaces unless the language syntax requires them).",
];

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/;

type Fence = { char: string; len: number };

function parseFence(line: string): (Fence & { lang: string }) | null {
	const m = line.match(FENCE_RE);
	if (!m) return null;
	return {
		char: m[1][0],
		len: m[1].length,
		lang: (m[2] ?? "").toLowerCase(),
	};
}

/** A closing fence: same char, at least as long, nothing else on the line. */
function closes(line: string, f: Fence): boolean {
	const t = line.trim();
	return t.length >= f.len && t === f.char.repeat(t.length);
}

export function renderMarkdownFences(markdown: string): string {
	const out: string[] = [];
	// Outer fence currently open (code or rendered-markdown).
	let open: (Fence & { render: boolean }) | null = null;
	// Fences nested inside a rendered-markdown block.
	const nested: Fence[] = [];

	for (const line of markdown.split("\n")) {
		if (!open) {
			const f = parseFence(line);
			if (f) {
				open = { ...f, render: RENDER_LANGS.has(f.lang) };
				if (open.render) out.push(...MD_OPEN);
				else out.push(line);
				continue;
			}
			out.push(line);
			continue;
		}

		if (!open.render) {
			// Ordinary code block: pass through verbatim until it closes.
			if (closes(line, open)) open = null;
			out.push(line);
			continue;
		}

		// Inside a rendered-markdown block.
		const top = nested[nested.length - 1];
		if (top) {
			if (closes(line, top)) nested.pop();
			out.push(line);
			continue;
		}
		const f = parseFence(line);
		if (f && f.lang) {
			// ```lang inside the markdown: an inner code block.
			nested.push(f);
			out.push(line);
			continue;
		}
		if (closes(line, open)) {
			open = null;
			out.push(...MD_CLOSE);
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

type Token = { type: string; lang?: string; text?: string };
type MdTheme = { codeBlockBorder(s: string): string };
type RenderToken = (
	this: { theme: MdTheme },
	token: Token,
	...rest: unknown[]
) => string[];
type CodeHit = {
	start: number;
	end: number;
	lang: string;
	code: string;
};
type PendingCode = CodeHit & {
	openLine: string;
	closeLine: string;
};

const ORIGINAL = Symbol.for("pi-kit:md-fence-render:renderToken");
const ORIGINAL_RENDER = Symbol.for("pi-kit:md-fence-render:render");
const ORIGINAL_MOUSE = Symbol.for("pi-kit:md-fence-render:handleMouse");
const PENDING_CODES = Symbol.for("pi-kit:md-fence-render:pendingCodes");
const CODE_HITS = Symbol.for("pi-kit:md-fence-render:codeHits");
const CODE_HITS_KEY = Symbol.for("pi-kit:md-fence-render:codeHitsKey");
const CLICK_COPY = Symbol.for("pi-kit:snippet-copy:click");

function findLine(
	lines: string[],
	needle: string,
	start: number,
): number {
	for (let i = start; i < lines.length; i++) {
		if (lines[i].includes(needle)) return i;
	}
	return -1;
}

/** Replace code fences and make their rendered rows clickable in fullscreen. */
function patchCodeBlocks() {
	const proto = Markdown.prototype as any;
	// Keep the true originals across /reload so patches don't stack.
	const original = (proto[ORIGINAL] ??= proto.renderToken) as RenderToken;
	if (!(ORIGINAL_RENDER in proto)) {
		proto[ORIGINAL_RENDER] = proto.render;
	}
	if (!(ORIGINAL_MOUSE in proto)) {
		proto[ORIGINAL_MOUSE] = proto.handleMouse;
	}
	const originalRender = proto[ORIGINAL_RENDER];
	const originalMouse = proto[ORIGINAL_MOUSE];

	proto.renderToken = function (token: Token, ...rest: unknown[]) {
		const lines = original.call(this, token, ...rest);
		if (token?.type !== "code" || lines.length < 2) return lines;
		const border = (s: string) => this.theme.codeBlockBorder(s);
		if (lines[0] !== border("```" + (token.lang ?? ""))) return lines;
		const close = lines.lastIndexOf(border("```"));
		if (close <= 0) return lines;
		const out = [...lines];
		out[close] = border(CLOSE);
		out[0] = border(`${OPEN} ${token.lang || "code"}`);
		(this[PENDING_CODES] ??= []).push({
			start: 0,
			end: 0,
			lang: token.lang ?? "",
			code: token.text ?? "",
			openLine: out[0],
			closeLine: out[close],
		} satisfies PendingCode);
		return out;
	};

	proto.render = function (width: number) {
		this[PENDING_CODES] = [];
		const key = `${width}\0${this.text ?? ""}`;
		const lines = originalRender.call(this, width) as string[];
		const pending = this[PENDING_CODES] as PendingCode[];
		if (!pending.length) {
			if (this[CODE_HITS_KEY] !== key) this[CODE_HITS] = [];
			this[CODE_HITS_KEY] = key;
			return lines;
		}
		const hits: CodeHit[] = [];
		let cursor = 0;
		for (const code of pending) {
			const start = findLine(lines, code.openLine, cursor);
			if (start < 0) continue;
			const end = findLine(lines, code.closeLine, start + 1);
			if (end < 0) continue;
			hits.push({
				start,
				end,
				lang: code.lang,
				code: code.code,
			});
			cursor = end + 1;
		}
		this[CODE_HITS] = hits;
		this[CODE_HITS_KEY] = key;
		return lines;
	};

	proto.handleMouse = function (event: any) {
		const prior = originalMouse?.call(this, event);
		if (prior) return prior;
		if (event.button !== "left") return undefined;
		const hit = (this[CODE_HITS] as CodeHit[] | undefined)?.find(
			(code) => event.y >= code.start && event.y <= code.end,
		);
		const copy = (globalThis as any)[CLICK_COPY];
		if (!hit || typeof copy !== "function") return undefined;
		if (event.type === "click") {
			copy({ lang: hit.lang, code: hit.code });
			return { handled: true };
		}
		if (
			event.type === "press" ||
			event.type === "release" ||
			event.type === "drag"
		) {
			return { handled: true, render: false };
		}
		return undefined;
	};
}

export default function mdFenceRender(pi: ExtensionAPI) {
	registerLoadedExtension("md-fence-render");
	patchCodeBlocks();

	pi.on("before_agent_start", (event) => {
		const g = event.systemPromptOptions.promptGuidelines;
		for (const line of COPY_GUIDELINES) if (!g.includes(line)) g.push(line);
	});

	pi.registerMarkdownTransformer((markdown, ctx) => {
		if (ctx.messageType !== "assistant") return markdown;
		return renderMarkdownFences(markdown);
	});
}
