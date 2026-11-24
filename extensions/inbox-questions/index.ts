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
			openScreen?.();
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
		let answer = action.answer;
		if (answer === "\u0000option") {
			// Quick-pick one of the offered options.
			const opts = q.options.map((o) => `${o.id}: ${o.text}`);
			const pick = await ctx.ui.select(`Answer ${q.key}`, opts);
			if (!pick) continue;
			answer = pick.split(":")[0].trim();
		}
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

/** One pass of the list UI; resolves with an answer action or undefined to close. */
async function runQuestionScreen(ctx: ExtensionContext, items: Question[]): Promise<ScreenAction> {
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

		return {
			render: () => lines(),
			invalidate: () => {},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape) || data === "q") return done(undefined);
				const cur = rows[selected];
				if (data === "a") {
					if (!cur || cur.state !== "open") return;
					// Free-text answer; the dialog handles its own input loop.
					ctx.ui.input(`Answer ${cur.key} (empty to cancel)`, "e.g. B — or your own reasoning")
						.then((text) => {
							if (text && text.trim()) done({ key: cur.key, answer: text.trim() });
						});
					return;
				}
				if (data === "o") {
					if (!cur || cur.state !== "open" || !cur.options.length) return;
					done({ key: cur.key, answer: "\u0000option" });
					return;
				}
				// Number keys answer with that option directly.
				if (cur && cur.state === "open" && /^[1-9]$/.test(data)) {
					const opt = cur.options[Number(data) - 1];
					if (opt) {
						done({ key: cur.key, answer: opt.id });
						return;
					}
				}
				if (matchesKey(data, Key.up) || data === "k") {
					selected = Math.max(0, selected - 1);
				} else if (matchesKey(data, Key.down) || data === "j") {
					selected = Math.min(rows.length - 1, selected + 1);
				} else return;
				tui.requestRender();
			},
		};
	});
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
