/**
 * inbox-questions — a separate, ephemeral question list layered on the inbox.
 *
 * The inbox extension's tabs (`View = "inbox" | "archived" | "all" | "filtered"`)
 * are a closed union wired through its counts, cycling and render, so an addon
 * cannot add a fifth tab. This extension therefore does NOT touch inbox internals.
 * It provides the two things that actually solve the problem, using only public
 * pi APIs:
 *
 *   1. A footer status — `❓ 2 awaiting answer` — via `ctx.ui.setStatus`, the same
 *      additive mechanism the inbox itself uses for `inbox-agents`. It appears in
 *      the footer/status bar, which is what "something in the inbox should tell me"
 *      means in practice.
 *
 *   2. A separate full-screen list on a shortcut (`/questions`, ctrl+shift+q),
 *      rendered with `ctx.ui.custom()`. Questions never enter the Inbox tab.
 *      Answer in place: `a` for free text, `o` to pick an option, or a number key
 *      (1-9) to answer with that option directly. An answer writes the record the
 *      jira-autopilot runner reads, so the loop closes without leaving the list.
 *
 * Questions are keyed by a marker file under
 * `~/.local/state/jira-autopilot/questions/<KEY>.json`, so the producer (the
 * jira-autopilot runner) and this list agree without sharing code.
 *
 * Ephemeral: answering a question removes it from the list immediately and the
 * record is deleted after `RETENTION_MS`, so a question is visible only while it
 * is genuinely waiting on you.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import { registerInboxHeaderProvider } from "../inbox/index.ts";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** How long an answered question stays visible before its record is deleted. */
const DEFAULT_RETENTION_MS = 60 * 60 * 1000; // 1 hour

type QuestionState = "open" | "answered";

interface Question {
	key: string;
	title: string;
	asked: string;
	decision: string;
	why?: string;
	context: string;
	options: { id: string; text: string; tradeoff?: string }[];
	recommendation?: string;
	blockedOn?: string;
	answer?: string;
	answeredAt?: number;
	state: QuestionState;
	/** Which producer owns this record (set by readQuestions, not on disk). */
	source?: string;
	/** Absolute path of the record, so an answer writes back to the right dir. */
	file?: string;
}

/**
 * Every producer that owns a question queue, in display order.
 *
 * Each unattended job keeps its own state dir, so a question can never be
 * answered against the wrong job (a Jira decision shown as a PR approval would
 * be actively dangerous). Adding a producer means adding one entry here.
 */
interface QuestionSource {
	/** Stable id, used to keep two jobs' keys from colliding. */
	id: string;
	dir: string;
}

function questionSources(): QuestionSource[] {
	const home = process.env.HOME ?? ".";
	const sources: QuestionSource[] = [
		{
			id: "jira",
			dir: path.join(
				process.env.JIRA_AUTOPILOT_STATE ?? path.join(home, ".local/state/jira-autopilot"),
				"questions",
			),
		},
		{
			id: "pr",
			dir: path.join(
				process.env.PR_AUTOPILOT_STATE ?? path.join(home, ".local/state/pr-review-autopilot"),
				"questions",
			),
		},
	];
	// Optional escape hatch: extra dirs, colon-separated, id = basename.
	const extra = process.env.PI_QUESTIONS_DIRS;
	if (extra) {
		for (const d of extra.split(":").filter(Boolean)) {
			sources.push({ id: path.basename(d) || "extra", dir: d });
		}
	}
	return sources;
}

/** The legacy single-dir accessor, kept for `ensureDir` compatibility. */
function questionsDir(): string {
	return questionSources()[0].dir;
}

function ensureDir(): string {
	const dir = questionsDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function readQuestions(): Question[] {
	const out: Question[] = [];
	const now = Date.now();
	const retention = Number(
		process.env.JIRA_AUTOPILOT_QUESTION_RETENTION_MS ?? DEFAULT_RETENTION_MS,
	);
	for (const src of questionSources()) {
		let names: string[] = [];
		try {
			names = fs.readdirSync(src.dir).filter((n) => n.endsWith(".json"));
		} catch {
			continue; // a producer that has never asked anything
		}
		for (const name of names) {
			const file = path.join(src.dir, name);
			try {
				const q = JSON.parse(fs.readFileSync(file, "utf-8")) as Question;
				if (!q?.key) continue;
				// Only "open" belongs in the list. "answered" stays briefly so the
				// row flips to ✓ before expiring; "resolved" is the producer's
				// bookkeeping that it has acted on the answer, and is not shown.
				if (q.state !== "open" && q.state !== "answered") continue;
				if (q.state === "answered" && q.answeredAt && now - q.answeredAt > retention) {
					try {
						fs.rmSync(file, { force: true });
					} catch {
						// best effort
					}
					continue;
				}
				// Tag the source so writeAnswer knows which dir to write back to,
				// and prefix the key so two jobs cannot shadow each other.
				out.push({ ...q, source: src.id, file });
			} catch {
				// unreadable/partial record — skip rather than break the list
			}
		}
	}
	// Open first (oldest asked first), then recently answered.
	out.sort((a, b) => {
		if (a.state !== b.state) return a.state === "open" ? -1 : 1;
		return a.asked.localeCompare(b.asked);
	});
	return out;
}

function openCount(): number {
	return readQuestions().filter((q) => q.state === "open").length;
}

function updateStatus(ctx: ExtensionContext): void {
	const n = openCount();
	if (n === 0) {
		ctx.ui.setStatus("inbox-questions", undefined);
		return;
	}
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(
		"inbox-questions",
		theme.fg("warning", `❓ ${n} awaiting answer`) + theme.fg("dim", " · /questions"),
	);
}

export default function (pi: ExtensionAPI) {
	registerLoadedExtension("inbox-questions");

	// Cheap poll: the producer writes files, so a 5s re-read keeps the count fresh
	// without importing anything from the inbox.
	let timer: ReturnType<typeof setInterval> | undefined;
	// Seed with the real count so the first tick only renders on an actual change,
	// and so a start with zero questions still clears a stale status.
	let lastCount = -1;

	pi.registerCommand("questions", {
		description: "List questions waiting on you (separate from the inbox)",
		handler: async (_args, ctx) => {
			const items = readQuestions();
			if (!items.length) {
				ctx.ui.notify("No questions waiting.", "info");
				return;
			}
			await showQuestions(ctx, items);
		},
	});

	pi.registerShortcut("ctrl+shift+q", {
		description: "Open the questions list",
		handler: async () => {
			pi.sendUserMessage("/questions", { expandPromptTemplates: true });
		},
	});

	// Contribute `❓ N questions` to the inbox header and claim `q` there, so the
	// list is reachable from the window ppark is actually looking at.
	let openScreen: (() => void) | undefined;
	const unregister = registerInboxHeaderProvider({
		id: "inbox-questions",
		text: () => {
			const n = openCount();
			return n ? `❓ ${n} question${n === 1 ? "" : "s"} · q` : undefined;
		},
		onQuitKey: () => {
			if (!openCount()) return false;
			// Defer: the inbox is closing its overlay in the same key handler, and a
			// command needs a fresh command context after that has unwound. Sending
			// synchronously here loses the message (or renders under the overlay).
			setTimeout(() => openScreen?.(), 50);
			return true;
		},
	});
	// The inbox hands control back after `q`; reopening is routed through the
	// command so it gets a fresh context (shortcuts have none).
	openScreen = () => {
		pi.sendUserMessage("/questions", { expandPromptTemplates: true });
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ensureDir();
		updateStatus(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			const n = openCount();
			if (n === lastCount) return;
			lastCount = n;
			try {
				updateStatus(ctx);
			} catch {
				// context gone (session switched/shutdown) — the next start reinstalls
			}
		}, 5000);
	});

	// A run may answer a question mid-session (the runner writes the record), so
	// re-read after each turn instead of waiting for the next 5s tick.
	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			const n = openCount();
			if (n === lastCount) return;
			lastCount = n;
			updateStatus(ctx);
		} catch {
			// context gone
		}
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		unregister();
	});
}

/** Full-screen, scrollable question list. Answering is done by replying, not here. */
async function showQuestions(ctx: ExtensionContext, initial: Question[]): Promise<void> {
	let items = initial;
	// Re-render after an answer: the row flips to answered and the open count drops.
	for (;;) {
		const action = await runQuestionScreen(ctx, items);
		if (!action) return;
		const q = items.find((x) => x.key === action.key);
		if (!q) return;
		const answer = action.answer;
		writeAnswer(q, answer);
		ctx.ui.notify(`${q.key} answered: ${answer.slice(0, 60)}`, "info");
		items = readQuestions();
		if (!items.length) {
			ctx.ui.notify("No questions left.", "info");
			return;
		}
	}
}

type ScreenAction = { key: string; answer: string } | undefined;

/**
 * The answer-mode state machine, kept pure so it is testable without a TUI.
 *
 * Nested dialogs are unusable inside a focused overlay (they render underneath),
 * so text entry and option picking are handled here. `feed` takes one raw key
 * chunk and returns the next state plus a completion when the user is done.
 */
export interface AnswerState {
	mode: "list" | "option" | "text";
	optCursor: number;
	draft: string;
}

export interface AnswerStep {
	state: AnswerState;
	/** Set when the user finished answering. */
	done?: { answer: string };
	/** Set when the user asked to leave the screen. */
	close?: true;
	/** Set when the user wants to move the list cursor instead. */
	move?: "up" | "down";
}

const KEY = {
	esc: (d: string) => matchesKey(d, Key.escape),
	enter: (d: string) => matchesKey(d, Key.enter) || matchesKey(d, Key.return) || d === "\r",
	up: (d: string) => matchesKey(d, Key.up) || d === "k",
	down: (d: string) => matchesKey(d, Key.down) || d === "j",
	backspace: (d: string) => matchesKey(d, Key.backspace) || d === "\u007f",
	/**
	 * Printable text. Accepts a multi-character chunk too: a bracketed paste
	 * arrives as one chunk, and dropping all but a single key would silently eat
	 * most of a pasted answer.
	 */
	printable: (d: string) =>
		d.length > 0 && [...d].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
};

export function feedAnswer(
	st: AnswerState,
	data: string,
	ctx: { canAnswer: boolean; optionCount: number },
): AnswerStep {
	if (st.mode === "option") {
		if (KEY.esc(data) || data === "q") return { state: { ...st, mode: "list" } };
		if (KEY.up(data)) return { state: { ...st, optCursor: Math.max(0, st.optCursor - 1) } };
		if (KEY.down(data))
			return { state: { ...st, optCursor: Math.min(ctx.optionCount - 1, st.optCursor + 1) } };
		if (KEY.enter(data) && ctx.optionCount > 0) {
			return { state: { ...st, mode: "list" }, done: { answer: String(st.optCursor) } };
		}
		return { state: st };
	}

	if (st.mode === "text") {
		if (KEY.esc(data)) return { state: { mode: "list", optCursor: 0, draft: "" } };
		if (KEY.enter(data)) {
			const text = st.draft.trim();
			if (text) return { state: { mode: "list", optCursor: 0, draft: "" }, done: { answer: text } };
			return { state: { mode: "list", optCursor: 0, draft: "" } };
		}
		if (KEY.backspace(data))
			return { state: { ...st, draft: st.draft.slice(0, -1) } };
		if (KEY.printable(data)) return { state: { ...st, draft: st.draft + data } };
		return { state: st };
	}

	// list mode
	if (KEY.esc(data) || data === "q") return { state: st, close: true };
	if (data === "a" && ctx.canAnswer) return { state: { mode: "text", optCursor: 0, draft: "" } };
	if (data === "o" && ctx.canAnswer && ctx.optionCount > 0)
		return { state: { mode: "option", optCursor: 0, draft: "" } };
	if (/^[1-9]$/.test(data) && ctx.canAnswer) {
		const i = Number(data) - 1;
		if (i < ctx.optionCount) return { state: st, done: { answer: String(i) } };
	}
	if (KEY.up(data)) return { state: st, move: "up" };
	if (KEY.down(data)) return { state: st, move: "down" };
	return { state: st };
}


/** One pass of the list UI; resolves with an answer action or undefined to close. */
async function runQuestionScreen(ctx: ExtensionContext, items: Question[]): Promise<ScreenAction> {
	// The inbox is itself a full-screen overlay in orchestrator mode, so a plain
	// `ui.custom()` screen renders UNDERNEATH it and never becomes visible. Match
	// the inbox's own presentation: an overlay that covers the same area.
	const opts = {
		overlay: true,
		overlayOptions: {
			width: "100%" as const,
			maxHeight: "100%" as const,
			anchor: "top-left" as const,
			margin: 0,
		},
	};

	return ctx.ui.custom<ScreenAction>((tui, theme, _kb, done) => {
		let selected = 0;
		const open = items.filter((q) => q.state === "open");
		const answered = items.filter((q) => q.state === "answered");
		const rows = [...open, ...answered];

		const lines = () => {
			const out: string[] = [];
			const w = 78;
			const bar = theme.fg("accent", "─".repeat(w));
			out.push(bar);
			const head = ` Questions  ${theme.fg("warning", `${open.length} awaiting`)}` +
				(answered.length ? theme.fg("dim", ` · ${answered.length} answered`) : "");
			out.push(head);
			out.push(bar);
			if (!rows.length) out.push(theme.fg("dim", " Nothing waiting on you."));
			rows.forEach((q, i) => {
				const isSel = i === selected;
				const mark = q.state === "open" ? theme.fg("warning", "●") : theme.fg("success", "✓");
				const label = ` ${mark} ${q.key} — ${q.title}`;
				out.push(isSel
					? theme.bg("selectedBg", theme.bold(truncateToWidth(label, w)))
					: truncateToWidth(label, w));
			});
			const sel = rows[selected];
			if (sel) {
				out.push("");
				out.push(theme.fg("accent", ` ${sel.key}`));
				out.push(` ${theme.bold("Decision:")} ${sel.decision}`);
				if (sel.why) for (const ln of wrap(`Why: ${sel.why}`, w - 2)) out.push(` ${ln}`);
				for (const ln of wrap(sel.context, w - 2)) out.push(` ${ln}`);
				if (sel.options.length) {
					out.push("");
					for (const o of sel.options) {
						const t = o.tradeoff ? ` ${theme.fg("dim", `— ${o.tradeoff}`)}` : "";
						out.push(`   ${theme.fg("accent", o.id)}: ${o.text}${t}`);
					}
				}
				if (sel.recommendation) {
					for (const ln of wrap(`My pick: ${sel.recommendation}`, w - 2)) {
						out.push(` ${theme.fg("dim", ln)}`);
					}
				}
				out.push("");
				if (sel.state === "answered") {
					out.push(` ${theme.fg("success", "Answer:")} ${sel.answer ?? ""}`);
				} else {
					out.push(theme.fg("dim", " a answer · o pick an option · ↑↓ move · esc close"));
				}
			}
			return out;
		};

		// Two modes, both handled by THIS component. Nested dialogs (`ctx.ui.input`,
		// `ctx.ui.select`) are not usable here: a focused overlay retains input
		// ownership, so a dialog opened from inside it is drawn underneath and never
		// appears. The inbox avoids them for the same reason and renders its own.
		let st: AnswerState = { mode: "list", optCursor: 0, draft: "" };

		const renderAnswerPrompt = () => {
			const cur = rows[selected];
			const w = 78;
			const out: string[] = [];
			out.push(theme.fg("accent", "─".repeat(w)));
			out.push(` Answer ${theme.bold(cur?.key ?? "")}`);
			out.push(theme.fg("accent", "─".repeat(w)));
			if (st.mode === "option") {
				(cur?.options ?? []).forEach((o, i) => {
					const isSel = i === st.optCursor;
					const label = `  ${o.id}: ${o.text}`;
					out.push(isSel ? theme.bg("selectedBg", theme.bold(truncateToWidth(label, w)))
						: truncateToWidth(label, w));
				});
				out.push("");
				out.push(theme.fg("dim", " ↑↓ choose · enter answer · esc back"));
			} else {
				out.push("");
				out.push(` ${st.draft}${theme.fg("accent", "▏")}`);
				out.push("");
				out.push(theme.fg("dim", " type your answer · enter save · esc back"));
			}
			return out;
		};

		return {
			render: () => (st.mode === "list" ? lines() : renderAnswerPrompt()),
			invalidate: () => {},
			handleInput: (data: string) => {
				const cur = rows[selected];
				const step = feedAnswer(st, data, {
					canAnswer: !!cur && cur.state === "open",
					optionCount: cur?.options.length ?? 0,
				});
				st = step.state;
				if (step.close) return done(undefined);
				if (step.done) {
					// Option picks come back as an index; resolve to the option id.
					const a = /^\d+$/.test(step.done.answer)
						? (cur?.options[Number(step.done.answer)]?.id ?? step.done.answer)
						: step.done.answer;
					return done({ key: cur!.key, answer: a });
				}
				if (step.move === "up") selected = Math.max(0, selected - 1);
				else if (step.move === "down") selected = Math.min(rows.length - 1, selected + 1);
				tui.requestRender();
			},
		};
	}, opts);
}

/**
 * Record an answer on disk. The runner reads these records, so writing here is
 * what actually completes the loop; the list then re-reads and the row flips to
 * answered (and disappears from the open count immediately).
 */
function writeAnswer(q: Question, answer: string): void {
	// Write back to the record's OWN directory. Falling back to the jira dir
	// would file a PR answer where the Jira runner reads it, which is exactly the
	// cross-job confusion this multi-source design exists to prevent.
	const dest = q.file ?? path.join(ensureDir(), `${q.key}.json`);
	const { source: _s, file: _f, ...clean } = q;
	const rec = { ...clean, state: "answered" as QuestionState, answer, answeredAt: Date.now() };
	const tmp = `${dest}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(rec, null, 1) + "\n");
	fs.renameSync(tmp, dest);
	// Keep the producer's markdown queue in step. `questions.md` is authoritative
	// for sync, so an answer recorded only here would be reverted to open on the
	// next pass — writing both sources means the answer survives either path.
	recordAnswerInMarkdown(dest, q.key, answer);
}

/**
 * Mirror an answer into the markdown queue that sits beside the records
 * (`<state>/questions.md`, one dir up from `…/questions/`). Best effort: the
 * JSON record is the machine contract, this is for the human and for `sync`.
 */
function recordAnswerInMarkdown(recordPath: string, key: string, answer: string): void {
	try {
		const md = path.join(path.dirname(path.dirname(recordPath)), "questions.md");
		if (!fs.existsSync(md)) return;
		const text = fs.readFileSync(md, "utf-8");
		// Replace the placeholder inside this key's block only.
		const head = `## ${key} `;
		const start = text.indexOf(head);
		if (start < 0) return;
		const next = text.indexOf("\n## ", start + head.length);
		const end = next < 0 ? text.length : next;
		const block = text.slice(start, end);
		if (!/^\*\*Answer:\*\*/m.test(block)) return;
		const updated = block.replace(/^\*\*Answer:\*\*.*$/m, `**Answer:** ${answer}`);
		if (updated === block) return;
		const tmp = `${md}.tmp`;
		fs.writeFileSync(tmp, text.slice(0, start) + updated + text.slice(end));
		fs.renameSync(tmp, md);
	} catch {
		// Never fail an answer because the markdown mirror could not be written.
	}
}

/** Small greedy wrapper so long context lines stay inside the panel. */
function wrap(text: string, width = 76): string[] {
	const words = text.split(/\s+/);
	const out: string[] = [];
	let cur = "";
	for (const w of words) {
		if (!cur.length) cur = w;
		else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
		else {
			out.push(cur);
			cur = w;
		}
	}
	if (cur) out.push(cur);
	return out;
}

// Re-exported for tests.
export { readQuestions, openCount, wrap, writeAnswer };
