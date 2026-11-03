/**
 * rename-chat — rename the current (or any) Pi session from the agent side.
 *
 * Registers a `rename-chat` tool the model can call (e.g. from a PR-review skill
 * that says "rename the chat session to `<author> <PR title>`"), plus a
 * `/rename [title]` command and a ctrl+r shortcut for interactive use.
 *
 * Renaming writes a session_info entry to the target session's file, so it works
 * for:
 *   - the current session in this process (pi.setSessionName, so the TUI title,
 *     terminal tab, and /resume picker update live), and
 *   - any other session on disk (including background agents spawned by the
 *     inbox extension, which the inbox list then shows by its new name).
 *
 * When `title` is omitted, the tool auto-generates a title from the session's
 * first user message (skill prefixes like /gh-pr-review are dropped).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgent } from "../../lib/inbox-agents.ts";

/** Root of all session files: ~/.pi/agent/sessions (one dir per cwd, slugged). */
const SESSIONS_DIR = path.join(getAgentDir(), "sessions");

/** Find a session file by id under the sessions dir (all-cwd inbox scan included). */
function findSessionFile(sessionsDir: string, id: string): string | undefined {
	// Only relative basenames / ids — never an arbitrary path (avoids a write-anywhere
	// primitive via prompt injection).
	const base = path.basename(id.replace(/\.jsonl$/, ""));
	if (!base || base === "." || base === "..") return undefined;
	try {
		// Session layout: <sessionsDir>/<cwd-slug>/<timestamp>_<id>.jsonl, plus any bare .jsonl.
		const subs = fs.readdirSync(sessionsDir, { withFileTypes: true });
		for (const sub of subs) {
			const dir = sub.isDirectory() || sub.isSymbolicLink() ? path.join(sessionsDir, sub.name) : sessionsDir;
			try {
				const hit = fs
					.readdirSync(dir)
					.find((n) => n === `${base}.jsonl` || (n.endsWith(".jsonl") && n.includes(`_${base}.jsonl`)));
				if (hit) return path.join(dir, hit);
			}
			catch {
				// unreadable dir — skip
			}
		}
	} catch {
		// dir missing/unreadable — fall through
	}
	return undefined;
}

/** First user message with skill invocations and command prefixes dropped, as a title source. */
function titleFromFirstMessage(file: string): string | undefined {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(64 * 1024);
			const n = fs.readSync(fd, buf, 0, buf.length, 0);
			const head = buf.toString("utf8", 0, n);
			for (const line of head.split("\n")) {
				if (!line.trim()) continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if ((entry as any)?.type === "session") continue;
				if ((entry as any)?.type !== "message") continue;
				const m = (entry as any).message as { role?: string; content?: unknown } | undefined;
				if (!m || m.role !== "user") continue;
				const text = firstText(m.content);
				if (!text) continue;
				let t = text.trim();
				// drop skill invocations: expanded <skill> blocks, raw /command prefixes, and
				// trailing inline $skill mentions (e.g. "… $gh-pr-review")
				t = t.replace(/<skill\s+name="[^"]*">[\s\S]*<\/skill>/g, " ").trim();
				t = t.replace(/<skill\s+name="[^"]*"\s*\/>/g, " ").trim();
				t = t.replace(/^\/[a-z0-9_-]+(:\S+)?\s*/i, "").trim();
				t = t.replace(/\s+\$[a-z0-9_-]+\s*$/i, "").trim();
				t = t.replace(/\s+/g, " ");
				return t || undefined;
			}
			return undefined;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

function firstText(content: unknown): string | undefined {
	if (typeof content === "string") return content || undefined;
	if (Array.isArray(content)) {
		for (const c of content) {
			if ((c as any)?.type === "text" && typeof (c as any).text === "string") return (c as any).text || undefined;
		}
		return undefined;
	}
	return undefined;
}

/** One name on one line, capped at the length pi stores. */
function cleanName(name: string): string {
	return name.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
}

/** `"… (empty = auto-title)"` labels mean an empty box is meaningful, so the prompt allows it. */
function autoTitleHint(label: string): string | undefined {
	return /empty =/.test(label) ? "empty = auto-title" : undefined;
}

/**
 * Open the rename box. The inbox extension registers `pi.inbox.rename-prompt` to pre-fill the
 * current name (↑ restores it); without it, pi's own dialog puts the name in a placeholder and
 * opens empty.
 */
function renameAsker(
	ctx: ExtensionContext,
): (title: string, current: string, emptyHint?: string) => Promise<string | undefined> {
	const prompt = (globalThis as any)[Symbol.for("pi.inbox.rename-prompt")];
	return (title, current, emptyHint) =>
		typeof prompt === "function"
			? prompt(ctx, { title, current, emptyHint })
			: ctx.ui.input(title, current);
}

export default function renameChatExtension(pi: ExtensionAPI) {
	registerLoadedExtension("rename-chat");
	pi.registerTool({
		name: "rename-chat",
		label: "Rename Chat",
		description:
			"Rename the current chat session so it is easy to find later in the session picker and inbox. " +
			"Call this when a conversation develops a clear topic: e.g. after fetching PR metadata for a PR review, " +
			"rename to `<author> <PR title>` (GitHub username of the PR author, then the verbatim PR title; trim a title " +
			"longer than ~60 chars at a word boundary; keep the author prefix). " +
			"Also call it when the user asks you to name, title, or rename this chat/session. " +
			"Leaving `title` empty auto-titles from the conversation's first user message. " +
			"Pass `session` (id or file basename) to rename a different session (e.g. a background agent) instead.",
		promptGuidelines: [
			"After fetching PR metadata at the start of a PR review, rename the session via rename-chat before drafting comments.",
		],
		renderCall(
			args: { title?: string; session?: string },
			theme: Theme,
		): { render: (w: number) => string[]; invalidate: () => void } {
			// one-line display for the transcript
			const target = args.session ? ` → ${args.session}` : "";
			const line = theme.fg("toolTitle", theme.bold("rename-chat")) + theme.fg("muted", `${target} "${(args.title ?? "(auto)").slice(0, 60)}"`);
			const cached: { w?: number; lines?: string[] } = {};
			return {
				render(width: number) {
					if (cached.w === width && cached.lines) return cached.lines;
					cached.w = width;
					cached.lines = [line];
					return cached.lines;
				},
				invalidate() {
					cached.w = undefined;
				},
			};
		},
		parameters: Type.Object({
			title: Type.Optional(
				Type.String({
					description:
						"New session name. Short and human-readable, e.g. `alex PROJ-123: Gate decision history behind a feature flag`. Omit to auto-title from the first user message.",
				}),
			),
			session: Type.Optional(
				Type.String({
					description:
						"Target session to rename other than the current one: a session id (from the inbox/agent registry) or a session file basename like `abc123.jsonl`. Defaults to the current session.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rawTitle = params.title?.trim();
			// Determine the target: current session or another one. A background agent's
			// id (from the inbox registry) is accepted directly.
			let targetFile: string | undefined;
			let isCurrent = !params.session || params.session.trim() === "";
			let bgAgentId: string | undefined;
			if (isCurrent) {
				targetFile = ctx.sessionManager.getSessionFile();
			} else {
				const key = params.session!.trim();
				// Live background agent (spawned by the inbox extension)? Rename its registry
				// entry too, so the inbox shows the new title even before its file is written.
				const bg = getAgent(key);
				if (bg) bgAgentId = key;
				targetFile = findSessionFile(SESSIONS_DIR, key) ?? bg?.sessionFile;
				isCurrent = !!targetFile && targetFile === ctx.sessionManager.getSessionFile();
				if (!targetFile && !bgAgentId) {
					return {
						content: [{ type: "text", text: `rename-chat: no session file found for "${key}".` }],
						details: { error: "session-not-found", key },
					};
				}
			}

			// Resolve the title: explicit, else auto-title, else give up. Auto-title prefers
			// the session file's first user message; a not-yet-persisted background agent falls
			// back to its registry title / queued prompt.
			let title = rawTitle;
			let autoTitled = false;
			if (!title) {
				const bg = bgAgentId ? getAgent(bgAgentId) : undefined;
				title =
					(targetFile ? titleFromFirstMessage(targetFile) : undefined) ??
					bg?.title ??
					bg?.pending?.[0]?.replace(/^\/[a-z0-9_-]+(:\S+)?\s*/i, "").trim();
				autoTitled = true;
			}
			if (!title) {
				return {
					content: [
						{
							type: "text",
							text: "rename-chat: no title given and the session has no user message to auto-title from. Pass `title`.",
						},
					],
					details: { error: "no-title" },
				};
			}
			// Keep names sane: single line, cap length.
			title = title.replace(/[\r\n]+/g, " ").trim().slice(0, 200);

			if (isCurrent) {
				// Live rename for the session this process holds: updates the TUI title,
				// terminal tab, and emits session_info_changed so /resume reflects it.
				pi.setSessionName(title);
			} else if (targetFile) {
				// Another session on disk: append a session_info entry via SessionManager.open
				// (same mechanism pi's own session-picker rename and the inbox's `r` rename use).
				// Inbox reads `name` from the file tail on refresh, so the new title shows within ~2.5s.
				SessionManager.open(targetFile).appendSessionInfo(title);
			}
			// Keep the in-memory registry entry for a live background agent in sync.
			if (bgAgentId) {
				const bg = getAgent(bgAgentId);
				if (bg) bg.title = title;
			}

			const content = `Renamed session${autoTitled ? " (auto-titled from first user message)" : ""} to "${title}".`;
			return {
				content: [{ type: "text", text: content }],
				details: { title, targetFile: targetFile ?? null, isCurrent, autoTitled },
			};
		},
	});

	pi.registerCommand("rename", {
		description: "Rename this session (usage: /rename [title] — empty title auto-titles)",
		handler: async (args, ctx) => {
			// Interactive naming follows the viewed session. The model-facing
			// tool above deliberately stays bound to its executing session.
			const hook = (globalThis as any)[Symbol.for("pi.inbox.rename-target")];
			const target = typeof hook === "function" ? hook(ctx) : undefined;
			const ask = renameAsker(ctx);
			const clean = cleanName;

			if (target) {
				if (args.trim()) {
					const message = target.apply(clean(args));
					if (message) ctx.ui.notify(message, "info");
					return;
				}
				const name = await ask(
					target.label,
					target.current ?? "",
					autoTitleHint(target.label),
				);
				if (name === undefined || name === null) return;
				const message = target.apply(clean(name));
				if (message) ctx.ui.notify(message, "info");
				return;
			}
			const title = args.trim();
			if (title) {
				pi.setSessionName(title);
				ctx.ui.notify(`Session renamed: ${title}`, "info");
				return;
			}
			// No args: ask in a box that already holds the current name. Submitting it unchanged is
			// a no-op; clearing it auto-titles from the first user message.
			const file = ctx.sessionManager.getSessionFile();
			const name = await ask(
				"Rename session",
				pi.getSessionName() ?? "",
				"empty = auto-title",
			);
			if (name === undefined || name === null) return;
			const next = clean(name);
			const auto = next || (file ? titleFromFirstMessage(file) : undefined) || "";
			if (!auto) {
				ctx.ui.notify("No user message yet — pass a title: /rename <title>", "warning");
				return;
			}
			pi.setSessionName(auto.slice(0, 200));
			ctx.ui.notify(`Session renamed: ${auto.slice(0, 200)}`, "info");
		},
	});

	// ctrl+r: prompt for a new name for the current session (main editor only;
	// the /resume picker keeps its own ctrl+r rename for the selected row).
	pi.registerShortcut("ctrl+r", {
		description: "Rename current session",
		handler: async (ctx) => {
			const ask = renameAsker(ctx);
			const clean = cleanName;
			// Orchestrator: name the viewed session or a pending new agent. Both boxes are pre-filled
			// with the current name (↑ restores it after edits).
			const hook = (globalThis as any)[Symbol.for("pi.inbox.rename-target")];
			const inbox = typeof hook === "function" ? hook(ctx) : undefined;
			if (inbox) {
				const v = await ask(
					inbox.label,
					inbox.current ?? "",
					autoTitleHint(inbox.label),
				);
				if (v === undefined || v === null) return;
				const msg = inbox.apply(clean(v));
				if (msg) ctx.ui.notify(msg, "info");
				return;
			}
			const current = pi.getSessionName() ?? "";
			const input = await ask("Rename session", current, "empty = auto-title");
			// esc / cancel
			if (input === undefined || input === null) return;
			let title = clean(input);
			// Submitting the name unchanged saves nothing (and avoids a pointless session_info entry).
			if (title === clean(current)) return;
			if (!title) {
				const file = ctx.sessionManager.getSessionFile();
				title = (file ? titleFromFirstMessage(file) : undefined) ?? "";
				if (!title) {
					ctx.ui.notify("No user message yet to auto-title from — type a name.", "warning");
					return;
				}
			}
			title = title.slice(0, 200);
			pi.setSessionName(title);
			ctx.ui.notify(`Session renamed: ${title}`, "info");
		},
	});
}
