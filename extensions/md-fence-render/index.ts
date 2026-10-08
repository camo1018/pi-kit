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
 * Pi hard-wraps long lines (each visual row is emitted with \r\n), so mouse
 * selection of a wrapped code line pastes as two lines. Nothing in the
 * renderer can avoid that, so steer the model toward copy-safe snippets.
 */
const COPY_GUIDELINES = [
	"Code blocks must be copy-paste safe from a narrow terminal: keep every line under 80 characters. Break long shell commands with trailing ` \\` continuations (or one flag per line); break long code expressions across lines.",
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

type Token = { type: string; lang?: string };
type MdTheme = { codeBlockBorder(s: string): string };
type RenderToken = (
	this: { theme: MdTheme },
	token: Token,
	...rest: unknown[]
) => string[];

const ORIGINAL = Symbol.for("pi-kit:md-fence-render:renderToken");

/** Replace code fence lines with a label; keep highlighted code lines. */
function patchCodeBlocks() {
	const proto = Markdown.prototype as unknown as {
		renderToken: RenderToken;
		[ORIGINAL]?: RenderToken;
	};
	// Keep the true original across /reload so patches don't stack.
	const original = (proto[ORIGINAL] ??= proto.renderToken);
	proto.renderToken = function (token, ...rest) {
		const lines = original.call(this, token, ...rest);
		if (token?.type !== "code" || lines.length < 2) return lines;
		const border = (s: string) => this.theme.codeBlockBorder(s);
		if (lines[0] !== border("```" + (token.lang ?? ""))) return lines;
		const close = lines.lastIndexOf(border("```"));
		if (close <= 0) return lines;
		const out = [...lines];
		out[close] = border(CLOSE);
		out[0] = border(`${OPEN} ${token.lang || "code"}`);
		return out;
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
