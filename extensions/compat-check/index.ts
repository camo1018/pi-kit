/**
 * compat-check — detect when a Pi upgrade breaks the pi-kit extensions that
 * reach into Pi internals (prototype patches, private methods, source shape).
 *
 * On startup and /reload it runs a probe per internal dependency and, if any
 * fail, shows a warning naming the extension, the probe, and the README that
 * explains how to recover. When everything passes it stays quiet, except for
 * a one-line note the first time a new Pi version is seen.
 *
 *   /compat    show the full probe report
 *
 * Probes are listed in PROBES below; each extension's README has a
 * "Pi internals" table that matches these probe ids. When you add a new
 * dependency on Pi internals, add a probe here and a row there.
 *
 * Last verified Pi version is kept in ~/.pi/agent/pi-kit-compat.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { registerLoadedExtension, finalizeLoadPass, getLoadedExtensions } from "../../lib/loaded-extensions.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as agent from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";

type Ctx = ExtensionContext;
interface Probe {
	/** Extension directory under extensions/ (README lives there). */
	ext: string;
	id: string;
	/** Returns true when OK, or a string describing what's wrong. */
	check: (ctx: Ctx, pi: ExtensionAPI) => true | string;
}

const A = agent as any;
const T = tui as any;

/** Look up a method anywhere on a class's prototype chain. */
function hasMethod(cls: any, name: string): boolean {
	for (let p = cls?.prototype; p; p = Object.getPrototypeOf(p)) {
		if (Object.prototype.hasOwnProperty.call(p, name)) return typeof p[name] === "function";
	}
	return false;
}

/** Source text of a class and its superclasses (for shape fingerprints). */
function classSource(cls: any): string {
	let s = "";
	for (let c = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) s += String(c);
	return s;
}

const need = (ok: boolean, msg: string): true | string => (ok ? true : msg);

const PROBES: Probe[] = [
	// ── md-fence-render ──────────────────────────────────────────────
	{
		ext: "md-fence-render",
		id: "markdown-transformer-api",
		check: (_c, pi) => need(typeof (pi as any).registerMarkdownTransformer === "function", "pi.registerMarkdownTransformer is gone"),
	},
	{
		ext: "md-fence-render",
		id: "markdown-render-token",
		check: () => need(hasMethod(T.Markdown, "renderToken"), "pi-tui Markdown.prototype.renderToken is missing"),
	},
	{
		ext: "md-fence-render",
		id: "markdown-fence-shape",
		check: () =>
			need(
				classSource(T.Markdown).includes("codeBlockBorder(`\\`\\`\\`${"),
				"Markdown no longer draws code fences via theme.codeBlockBorder(`\\`\\`\\`lang`)",
			),
	},
	{
		ext: "md-fence-render",
		id: "code-block-label-renders",
		check: () => {
			if (!T.Markdown) return "pi-tui Markdown export is missing";
			const theme = new Proxy({} as any, {
				get: (_t, k) =>
					k === "codeBlockIndent" ? "" : k === "highlightCode" ? (c: string) => c.split("\n") : (s: string) => s,
			});
			try {
				const out: string = new T.Markdown("```bash\necho hi\n```", 0, 0, theme).render(60).join("\n");
				if (out.includes("```")) return "code block still renders ``` fence lines (patch not applied)";
				if (!out.includes("┌─ bash") || !out.includes("└─")) return "code block start/end markers missing from rendered output";
				return true;
			} catch (e) {
				return `rendering a code block threw: ${(e as Error).message}`;
			}
		},
	},
	{
		ext: "md-fence-render",
		id: "code-block-click-routes",
		check: () => {
			if (!hasMethod(T.Markdown, "handleMouse")) {
				return "Markdown.handleMouse click patch is missing";
			}
			const key = Symbol.for("pi-kit:click-copy:click");
			const previous = (globalThis as any)[key];
			let copied: any;
			(globalThis as any)[key] = (block: any) => {
				copied = block;
			};
			const same = (s: string) => s;
			const theme = new Proxy({} as any, {
				get: (_t, name) => {
					if (name === "codeBlockIndent") return "";
					if (name === "highlightCode") return undefined;
					return same;
				},
			});
			try {
				const md = new T.Markdown(
					"```bash\necho hi\n```",
					0,
					0,
					theme,
				);
				const lines = md.render(60) as string[];
				const y = lines.findIndex((line) => line.includes("echo hi"));
				if (y < 0) return "rendered code row was not found";
				const press = md.handleMouse({
					type: "press",
					button: "left",
					y,
				});
				md.handleMouse({ type: "click", button: "left", y });
				if (!press?.handled) return "code-block press was not claimed";
				if (copied?.code !== "echo hi") {
					return "code-block click did not route exact source";
				}
				return true;
			} catch (e) {
				return `clicking a code block threw: ${(e as Error).message}`;
			} finally {
				if (previous === undefined) delete (globalThis as any)[key];
				else (globalThis as any)[key] = previous;
			}
		},
	},

	// ── tool-output-hide ─────────────────────────────────────────────
	{
		ext: "tool-output-hide",
		id: "tool-execution-render",
		check: () =>
			need(hasMethod(A.ToolExecutionComponent, "render"), "ToolExecutionComponent (or its render method) is no longer exported"),
	},
	{
		ext: "tool-output-hide",
		id: "custom-editor-handle-input",
		check: () => need(hasMethod(A.CustomEditor, "handleInput"), "CustomEditor (or handleInput) is no longer exported"),
	},
	{
		ext: "tool-output-hide",
		id: "custom-editor-action-handlers",
		check: () =>
			need(
				classSource(A.CustomEditor).includes("actionHandlers"),
				"CustomEditor no longer dispatches app keys via actionHandlers",
			),
	},
	{
		ext: "tool-output-hide",
		id: "tools-expanded-ui-api",
		check: (c) =>
			need(
				!c.hasUI || (typeof (c.ui as any).getToolsExpanded === "function" && typeof (c.ui as any).setToolsExpanded === "function"),
				"ctx.ui.getToolsExpanded / setToolsExpanded are gone",
			),
	},
	{
		ext: "tool-output-hide",
		id: "patch-installed",
		check: () =>
			need(
				(globalThis as any)[Symbol.for("pi.ext.tool-output-hide")]?.patched === true,
				"extension loaded but its prototype patches were not installed",
			),
	},

	// ── inbox ────────────────────────────────────────────────────────
	{
		ext: "inbox",
		id: "tui-composite-methods",
		check: () => {
			const missing = ["TuiMainScreen", "TuiAltScreen"].flatMap((n) =>
				["compositeOverlays", "compositeLineAt"].filter((m) => !hasMethod(T[n], m)).map((m) => `${n}.${m}`),
			);
			return need(!missing.length, `missing: ${missing.join(", ")} (images will draw over overlays again)`);
		},
	},
	{
		ext: "inbox",
		id: "tui-composite-dispatch",
		check: () =>
			need(
				classSource(T.TuiMainScreen).includes("this.compositeLineAt(") &&
					classSource(T.TuiMainScreen).includes("this.compositeOverlays("),
				"compositing no longer goes through this.compositeOverlays/compositeLineAt, so instance patches are bypassed",
			),
	},
	{
		ext: "inbox",
		id: "tui-focused-component",
		check: () => need(hasMethod(T.TuiMainScreen, "getFocusedComponent"), "TUI.getFocusedComponent is gone (esc-to-cancel reply breaks)"),
	},
	{
		ext: "inbox",
		id: "editor-methods",
		check: () => {
			const missing = ["getText", "insertTextAtCursor", "isShowingAutocomplete"].filter((m) => !hasMethod(T.Editor, m));
			return need(!missing.length, `Editor is missing ${missing.join(", ")}`);
		},
	},
	{
		ext: "inbox",
		id: "keybindings-get-keys",
		check: () => {
			try {
				return need(typeof T.getKeybindings?.()?.getKeys === "function", "getKeybindings().getKeys is gone (help shows fallback keys)");
			} catch (e) {
				return `getKeybindings() threw: ${(e as Error).message}`;
			}
		},
	},
	{
		ext: "inbox",
		id: "session-manager-api",
		check: () => {
			const SM = A.SessionManager;
			const missing = [
				typeof SM?.open === "function" ? "" : "SessionManager.open",
				...["getBranch", "getSessionFile", "getSessionId", "appendSessionInfo"]
					.filter((m) => !hasMethod(SM, m))
					.map((m) => `SessionManager#${m}`),
			].filter(Boolean);
			return need(!missing.length, `missing: ${missing.join(", ")}`);
		},
	},
	{
		ext: "inbox",
		id: "session-file-layout",
		check: (c) => {
			// inbox-agents.findSessionFile and rename-chat scan sessions/<cwd-slug>/<timestamp>_<id>.jsonl.
			const file = c.sessionManager?.getSessionFile?.();
			const id = c.sessionManager?.getSessionId?.();
			if (!file || !id) return true; // in-memory session: nothing to compare
			const root = path.join(agent.getAgentDir(), "sessions");
			const rel = path.relative(root, file).split(path.sep);
			const ok = rel.length === 2 && !rel[0]!.startsWith("..") && rel[1]!.endsWith(`_${id}.jsonl`);
			return need(ok, `session file ${file} is not at sessions/<cwd-slug>/<timestamp>_<id>.jsonl`);
		},
	},
	{
		ext: "inbox",
		id: "ui-custom",
		check: (c) => need(!c.hasUI || typeof c.ui.custom === "function", "ctx.ui.custom is gone (inbox overlay can't open)"),
	},
	{
		ext: "inbox",
		id: "json-mode-events",
		check: () => {
			// Background agents parse `pi --mode json`. Check the bundled docs still list the events we use.
			const docs = typeof A.getDocsPath === "function" ? A.getDocsPath() : undefined;
			const file = docs && path.join(docs, "json.md");
			if (!file || !fs.existsSync(file)) return true; // docs not shipped: nothing to compare
			const text = fs.readFileSync(file, "utf-8");
			const events = [
				"agent_start",
				"tool_execution_start",
				"tool_execution_end",
				"message_update",
				"message_end",
				"auto_retry_start",
				"auto_retry_end",
				"compaction_start",
			];
			const missing = events.filter((e) => !text.includes(e));
			return need(!missing.length, `json.md no longer documents: ${missing.join(", ")}`);
		},
	},
	{
		ext: "inbox",
		id: "visit-chat-container",
		check: () => {
			// lib/visit-runtime.ts interposes the chat container's mutation methods
			// while a visit is open, mirroring pi-tui Container's plain-array
			// semantics (push / indexOf-splice / replace-all). Verify those
			// semantics on a real Container; openVisit additionally falls back to a
			// real session switch when the chat container can't be found.
			try {
				const { Container: C } = T;
				const box = new C();
				const a = { render: () => ["a"] as string[], invalidate: () => {} };
				const b = { render: () => ["b"] as string[], invalidate: () => {} };
				box.addChild(a);
				box.addChild(b);
				if (!Array.isArray(box.children) || box.children.length !== 2) {
					return "Container.children is not a plain array (visit stash/restore breaks)";
				}
				box.removeChild(a);
				if (box.children.length !== 1 || box.children[0] !== b) {
					return "Container.removeChild no longer splices children";
				}
				box.clear();
				if (box.children.length !== 0) return "Container.clear no longer empties children";
				return true;
			} catch (e) {
				return `Container probe threw: ${(e as Error).message}`;
			}
		},
	},
];

interface Result {
	probe: Probe;
	ok: boolean;
	detail?: string;
	/** Probe skipped: its extension is not loaded (selective install). */
	skipped?: boolean;
}

function runProbes(ctx: Ctx, pi: ExtensionAPI): Result[] {
	// This factory runs last among pi-kit extensions, so finalize first: the
	// pass set then contains exactly the extensions loaded *this* time.
	const loaded = finalizeLoadPass();
	return PROBES.map((probe) => {
		// Extensions excluded by a selective install (install.sh --extensions,
		// pi config) are not loaded and cannot be broken; skip their probes.
		if (!loaded.has(probe.ext)) return { probe, ok: true, skipped: true };
		try {
			const r = probe.check(ctx, pi);
			return r === true ? { probe, ok: true } : { probe, ok: false, detail: r };
		} catch (e) {
			return { probe, ok: false, detail: `probe threw: ${(e as Error).message}` };
		}
	});
}

const STATE_FILE = path.join(agent.getAgentDir(), "pi-kit-compat.json");
/** extensions/ directory, for README paths in the report. */
const EXT_DIR = (() => {
	try {
		return path.dirname(path.dirname(new URL(import.meta.url).pathname));
	} catch {
		return "extensions";
	}
})();

function readState(): { lastOkVersion?: string } {
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
	} catch {
		return {};
	}
}

function report(results: Result[], all: boolean): string {
	const lines: string[] = [];
	const byExt = new Map<string, Result[]>();
	for (const r of results) byExt.set(r.probe.ext, [...(byExt.get(r.probe.ext) ?? []), r]);
	for (const [ext, rs] of byExt) {
		const bad = rs.filter((r) => !r.ok);
		if (!all && !bad.length) continue;
		if (all && rs.every((r) => r.skipped)) {
			lines.push(`· ${ext}  (not loaded — selective install; probes skipped)`);
			continue;
		}
		lines.push(`${bad.length ? "✗" : "✓"} ${ext}${bad.length ? `  → ${path.join(EXT_DIR, ext, "README.md")}` : ""}`);
		for (const r of all ? rs : bad)
			lines.push(`    ${r.skipped ? "·" : r.ok ? "✓" : "✗"} ${r.probe.id}${r.detail ? `: ${r.detail}` : ""}`);
	}
	return lines.join("\n");
}

export default function compatCheck(pi: ExtensionAPI) {
	registerLoadedExtension("compat-check");
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;
		if (!ctx.hasUI) return;
		const version: string = A.VERSION ?? "unknown";
		const results = runProbes(ctx, pi);
		const failed = results.filter((r) => !r.ok && !r.skipped);
		if (failed.length) {
			ctx.ui.notify(`pi-kit: ${failed.length} internal check(s) failed on Pi ${version}\n${report(results, false)}`, "warning");
			return;
		}
		const state = readState();
		if (state.lastOkVersion !== version) {
			const run = results.filter((r) => !r.skipped).length;
			if (state.lastOkVersion) ctx.ui.notify(`pi-kit: all ${run} internal checks pass on Pi ${version} (was ${state.lastOkVersion})`, "info");
			try {
				fs.writeFileSync(STATE_FILE, JSON.stringify({ lastOkVersion: version, checkedAt: new Date().toISOString() }, null, 2));
			} catch {
				// best effort
			}
		}
	});

	pi.registerCommand("compat", {
		description: "Check pi-kit extensions against this Pi version's internals",
		handler: async (_args, ctx) => {
			const results = runProbes(ctx, pi);
			const failed = results.filter((r) => !r.ok && !r.skipped).length;
			const run = results.filter((r) => !r.skipped).length;
			const head = `Pi ${A.VERSION ?? "unknown"}: ${run - failed}/${run} checks pass`;
			ctx.ui.notify(`${head}\n${report(results, true)}`, failed ? "warning" : "info");
		},
	});
}
