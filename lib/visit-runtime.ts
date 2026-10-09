/**
 * Visit runtime: orchestrator sticky takeover.
 *
 * Problem: when a session is taken over in orchestrator mode, opening another
 * session switches the window onto it, which aborts the taken-over session's
 * in-flight run and restarts it as a background agent (prepareLeave). The user
 * wants the takeover to be *sticky*: the taken-over session keeps running
 * interactively in this window while other sessions are merely visited, and
 * every other session still runs as a background agent.
 *
 * Mechanism (all inside this pi process; no foreground claim on visited files):
 *
 *   main session A (taken over) stays THE window session — its AgentSession,
 *   runtime host, editor, footer binding, and event subscriptions are never
 *   touched. While A runs, pi's own agent events keep appending into A's chat
 *   tree, which we stash off-screen; the run never aborts.
 *
 *   B is *visited*: rendered by our own components — the same ones pi uses
 *   (UserMessageComponent / AssistantMessageComponent / ToolExecutionComponent
 *   over a Container) — driven by the visited session's persisted branch plus
 *   the inbox's existing background-agent live stream, so a visited working
 *   agent looks exactly like an attached one. Visits are view-only: messages
 *   typed while visiting are delivered to B's background agent (the
 *   orchestrator's existing reply/queue paths); the visited session is never
 *   claimed as a foreground writer of its file.
 *
 *   Chat-tree stash: interactive mode's chatContainer is a plain pi-tui
 *   Container whose `children` array we swap (see `chatContainerOf`). Restoring
 *   A is one array assignment — instant, and captures anything streamed while
 *   hidden. The footer shows the visited session while one is open (display
 *   proxy over its SessionManager); it is restored on close.
 *
 * Pi internals used (probed by compat-check, ids `visit-*`):
 *   - interactive mode mounts documentContainer with [header, resources, chat]
 *     as tui.children[0]; chat is its LAST child.
 *   - the 7 top-level mounts are [document, pending, status, widgetsAbove,
 *     editor, widgetsBelow, footer]; the footer component has setSession().
 *   - `Container.addChild/removeChild/clear` operate on a `children` array
 *     (pi-tui stack.js / tui.js).
 *   - message component constructor shapes (same as the inbox live stream).
 */

import {
	SessionManager,
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import { getAgent, isRunning, onAgentEvent, type BgAgent, type LiveMsg } from "./inbox-agents.ts";

// ───────────────────────────── visit state ─────────────────────────────

export interface VisitInfo {
	id: string;
	file: string;
	cwd: string;
	title: string;
	/** The container pi's chat area shows for the visit. */
	view: VisitView;
	/** A's stashed chat children (the live tree, restored on return). */
	stashed: unknown[];
	/** The footer session we replaced (restored on close), if swapped. */
	footerSession?: unknown;
}

export interface VisitState {
	/** The sticky taken-over session id (the window's real foreground session). */
	mainId: string;
	visit?: VisitInfo;
	/** Installed interposition (chat container patch); undefined when not visiting. */
	restoreChat?: () => void;
}

const VISIT_KEY = Symbol.for("pi.inbox.visitState");
const VISIT_LISTENER_KEY = Symbol.for("pi.inbox.visitListener");
export function visitState(): VisitState {
	const g = globalThis as any;
	return (g[VISIT_KEY] ??= { mainId: "" }) as VisitState;
}

export function visiting(): VisitInfo | undefined {
	return visitState().visit;
}

export function visitingId(): string | undefined {
	return visitState().visit?.id;
}

/** True while the chat area shows a visited session (the main keeps running). */
export function isVisiting(): boolean {
	return !!visitState().visit;
}

// ───────────────────────────── layout access ─────────────────────────────

/** The chat container of pi's interactive mode (documentContainer's last child). */
export function chatContainerOf(tui: TUI): Container | undefined {
	const doc = (tui as any).children?.[0];
	const chat = doc?.children?.[doc.children.length - 1];
	return Array.isArray(chat?.children) ? chat : undefined;
}

/** The footer component (setSession) among the top-level mounts, if reachable. */
function footerComponentOf(tui: TUI): any | undefined {
	const mounts = (tui as any).children ?? [];
	for (const mount of mounts) {
		for (const child of mount?.children ?? []) {
			if (typeof child?.setSession === "function" && typeof child?.getSessionStats === "function") return child;
		}
	}
	return undefined;
}

// ───────────────────────────── rendering ─────────────────────────────

/** Display shape for one rendered item (same shapes as the live-run messages). */
interface UserItem {
	role: "user";
	text: string;
	/** Wire message id (absent on locally-seeded items), for transcript dedupe. */
	id?: string;
}
interface AssistantItem {
	role: "assistant";
	message: any;
	tools: { name: string; id: string; args: any; result?: any }[];
}
type VisitItem = UserItem | AssistantItem;

/** A message rendering, rebuilt only when its source item changes. */
class VisitMsgCache {
	entry?: { source: any; parts: any[] };

	get(m: UserItem | AssistantItem | LiveMsg, md: any, tui: TUI): any[] {
		if (this.entry && this.entry.source === m) {
			const first = this.entry.parts[0];
			if (first?.updateContent && m.role === "assistant") first.updateContent(m.message, true);
			return this.entry.parts;
		}
		const parts: any[] = [];
		if (m.role === "user") {
			parts.push(new UserMessageComponent((m as UserItem).text ?? "", md, 0));
		} else {
			parts.push(new AssistantMessageComponent((m as AssistantItem | LiveMsg).message, true, md, "Thinking…", 0));
			for (const t of (m as AssistantItem | LiveMsg).tools ?? []) {
				const tc = new ToolExecutionComponent(t.name, t.id, t.args, { showImages: false }, undefined, tui, "");
				if (t.result) tc.updateResult(t.result);
				parts.push(tc);
			}
		}
		this.entry = { source: m, parts };
		return parts;
	}
}

/**
 * The visited session's active branch as render items, with tool results attached.
 * The in-flight run's persisted tail is trimmed: the live run replays the whole
 * run (seeded prompt + streamed turns), so once the child has flushed those
 * messages to the session file they would render twice. The tail is matched by
 * wire message id (see the trim below) so the live replay owns the run.
 */
function branchItems(file: string, liveMsgs: LiveMsg[]): VisitItem[] {
	const items: VisitItem[] = [];
	const toolById = new Map<string, AssistantItem["tools"][number]>();
	let branch: any[] = [];
	try {
		branch = SessionManager.open(file).getBranch() as any[];
	} catch {
		return [];
	}
	for (const e of branch) {
		if (e?.type !== "message") continue;
		const m = e.message;
		if (!m) continue;
		if (m.role === "user") {
			items.push({ role: "user", text: userText(m), id: m.id });
		} else if (m.role === "assistant") {
			const tools = (Array.isArray(m.content) ? m.content : [])
				.filter((c: any) => c?.type === "toolCall")
				.map((c: any) => ({ name: c.name, id: c.id, args: c.arguments ?? c.args, result: undefined as any }));
			const item: AssistantItem = { role: "assistant", message: m, tools };
			items.push(item);
			for (const t of tools) toolById.set(t.id, t);
		} else if (m.role === "toolResult") {
			const t = toolById.get(m.toolCallId);
			if (t) t.result = m;
		}
	}
	// The in-flight run's persisted tail is trimmed so the run renders once: the
	// live replay owns the whole run (seeded prompt + streamed turns), and once
	// the child flushes those messages to the session file they would render
	// twice. Matching is by exact wire message ids — never by prompt text — so an
	// identical re-prompt of a fresh run never trims the previous run's history.
	//   • a user id match: the echo of the run prompt (or a steer) was persisted;
	//   • an assistant id match: this run's turns are already in the file — trim
	//     back to the user message that precedes them (also covers runs so long
	//     the live trim dropped the seeded prompt).
	const liveUserIds = new Set(
		liveMsgs
			.filter((m) => m.role === "user")
			.map((m) => m.id)
			.filter(Boolean),
	);
	const liveAssistantIds = new Set(
		liveMsgs
			.filter((m) => m.role === "assistant")
			.map((m) => m.message?.id)
			.filter(Boolean),
	);
	if (liveUserIds.size || liveAssistantIds.size) {
		let matched = false; // a flushed assistant turn of this run was found
		for (let i = items.length - 1; i >= 0; i--) {
			const it = items[i]!;
			if (it.role === "assistant") {
				if (liveAssistantIds.has(it.message?.id)) matched = true;
				continue;
			}
			// The branch's newest user message starts this run's persisted tail.
			if (matched || liveUserIds.has(it.id)) items.length = i;
			break;
		}
	}
	return items;
}

function userText(m: any): string {
	if (typeof m.content === "string") return m.content;
	return (Array.isArray(m.content) ? m.content : [])
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("");
}

/** A visited session's chat: persisted branch + live run, same components as pi. */
export class VisitView extends Container {
	readonly [Symbol.for("pi.inbox.visitView")] = true;
	readonly cacheVersion = 1;
	private branchItems: VisitItem[] = [];
	private branchCache: VisitMsgCache[] = [];
	private liveCache: VisitMsgCache[] = [];
	private branchKey = "";
	private liveKey = "";

	constructor(
		private tui: TUI,
		private target: () => string,
	) {
		super();
	}

	agentId(): string {
		return this.target();
	}

	private sync(): void {
		const st = visitState().visit;
		if (!st) return;
		// Live run (the background agent's stream for this session).
		const msgs: LiveMsg[] = getAgent(st.id)?.liveRun?.msgs ?? [];
		// Persisted history: rebuild when the file grew or the in-flight run's
		// persisted tail appeared (trimming it changes the item list).
		const branch = branchItems(st.file, msgs);
		const branchKey = `${branch.length}:${(branch[branch.length - 1] as AssistantItem | undefined)?.message?.id ?? ""}`;
		if (branchKey !== this.branchKey) {
			this.branchKey = branchKey;
			this.branchItems = branch;
			this.branchCache = branch.map(() => new VisitMsgCache());
		}
		// Live run cache: rebuild when the run's message list changes.
		const liveKey = msgs.length ? `${msgs.length}:${msgs[msgs.length - 1]?.rev ?? 0}` : "0";
		if (liveKey !== this.liveKey) {
			this.liveKey = liveKey;
			this.liveCache = msgs.map(() => new VisitMsgCache());
		}
		const md = getMarkdownTheme();
		const next: any[] = [];
		let last = "";
		for (let i = 0; i < this.branchItems.length; i++) {
			if (this.branchItems[i].role === "user" && last) next.push(new Spacer(1));
			last = this.branchItems[i].role;
			next.push(...this.branchCache[i].get(this.branchItems[i], md, this.tui));
		}
		for (let i = 0; i < msgs.length; i++) {
			if (msgs[i].role === "user" && last) next.push(new Spacer(1));
			last = msgs[i].role;
			next.push(...this.liveCache[i].get(msgs[i], md, this.tui));
		}
		this.children = next;
	}

	render(width: number): string[] {
		this.sync();
		return super.render(width);
	}

	invalidate(): void {
		this.branchKey = ""; // re-scan the file next render
		super.invalidate();
	}
	dispose(): void {}
}

/** Re-render the visit view when the agent or its file changes. */
function ensureListener(tui: TUI) {
	const g = globalThis as any;
	if (typeof g[VISIT_LISTENER_KEY] === "function") return;
	g[VISIT_LISTENER_KEY] = onAgentEvent((ev: any) => {
		const st = visitState().visit;
		if (!st) return;
		if (ev?.agent && ev.agent.id !== st.id) return;
		st.view.invalidate();
		tui.requestRender();
	});
}

// ───────────────────────────── footer display proxy ─────────────────────────────

/**
 * Display-only session facade for the footer while visiting: reads come from
 * the visited session's file (SessionManager) and recorded model; nothing can
 * mutate or claim the visited session.
 */
function footerProxy(file: string, modelRegistry: any, recorded: string | undefined): any {
	const sm = SessionManager.open(file);
	const [provider, id, level] = (recorded ?? "").split(/[:/]/);
	let model: any;
	try {
		model =
			modelRegistry
				?.getAvailable?.()
				.find((m: any) => (!provider || m.provider === provider) && (!id || m.id === id)) ?? undefined;
	} catch {
		model = undefined;
	}
	// The footer reads state.model / state.thinkingLevel / sessionManager /
	// getContextUsage / routedModel / modelRuntime.isUsingSubscription(). The
	// registry the extension sees has no isUsingSubscription (that's
	// ModelRuntime, private to the session) — expose exactly the surface the
	// footer touches, with honest fallbacks.
	const modelRuntimeFacade = {
		isUsingSubscription: () => false,
		getAvailable: () => modelRegistry?.getAvailable?.() ?? [],
	};
	return {
		get sessionManager() {
			return sm;
		},
		get state() {
			return { model, thinkingLevel: level || undefined };
		},
		get model() {
			return model;
		},
		routedModel: undefined,
		modelRuntime: modelRuntimeFacade,
		getContextUsage: () => undefined,
	};
}

// ───────────────────────────── open / close ─────────────────────────────

export interface OpenVisitOpts {
	mainId: string;
	id: string;
	file: string;
	cwd: string;
	title: string;
	modelRegistry?: any;
	/** "provider/model:level" recorded for the visited session, for the footer. */
	recordedModel?: string;
}

/**
 * While a visit is open, pi's interactive mode may still write to the chat
 * container (the main session's run keeps streaming into it: message_start,
 * tool components, status lines, renderCurrentSessionState on rebinds). Those
 * calls must land in the stashed tree, not in the visit view. Interpose the
 * container's mutation methods: writes go to a hidden proxy container holding
 * the stashed tree; the visible children render the visit view only.
 *
 * The interposition is per-container, installed at openVisit and fully removed
 * at closeVisit. Container's plain semantics (push / indexOf-splice /
 * replace-all) are mirrored exactly; only the target changes.
 */
function interposeChat(chat: Container, view: Container): () => void {
	const hidden = new Container(); // proxy target: the stashed live tree
	const origChildren = chat.children as any[];
	const self = chat as any;
	const original = {
		addChild: self.addChild,
		removeChild: self.removeChild,
		clear: self.clear,
		invalidate: self.invalidate,
	};

	// The stash starts as a copy; the hidden proxy owns it from now on.
	hidden.children = origChildren.slice();

	self.addChild = (c: any) => {
		hidden.children.push(c);
	};
	self.removeChild = (c: any) => {
		const i = hidden.children.indexOf(c);
		if (i !== -1) hidden.children.splice(i, 1);
	};
	self.clear = () => {
		hidden.children = [];
	};
	self.invalidate = () => {
		view.invalidate();
		for (const c of hidden.children) c.invalidate?.();
	};

	// The chat container's visible children become exactly the visit view.
	origChildren.length = 0;
	origChildren.push(view);

	return () => {
		self.addChild = original.addChild;
		self.removeChild = original.removeChild;
		self.clear = original.clear;
		self.invalidate = original.invalidate;
		// Restore the real tree: whatever the main's run built while hidden.
		origChildren.length = 0;
		origChildren.push(...hidden.children);
	};
}

/**
 * Start a visit: stash the main session's live chat tree and mount the visited
 * session's view. Call only when `isVisiting()` is false. Returns false if the
 * chat container can't be found (compat failure → callers refuse the visit;
 * sticky takeover must never fall through to a destructive real switch).
 */
export function openVisit(tui: TUI, ctx: { modelRegistry?: any }, o: OpenVisitOpts): boolean {
	const st = visitState();
	if (st.visit) return true;
	const chat = chatContainerOf(tui);
	if (!chat) return false;
	ensureListener(tui);
	const view = new VisitView(tui, () => visitState().visit?.id ?? o.id);
	const info: VisitInfo = {
		id: o.id,
		file: o.file,
		cwd: o.cwd,
		title: o.title,
		view,
		stashed: [],
	};
	// Footer swap (display only; best effort).
	try {
		const footer = footerComponentOf(tui);
		if (footer) {
			info.footerSession = footer.session;
			footer.setSession(footerProxy(o.file, o.modelRegistry ?? ctx.modelRegistry, o.recordedModel));
		}
	} catch {
		// Footer keeps showing the main session; harmless.
	}
	st.mainId = o.mainId;
	st.visit = info;
	// Stash the main's live tree behind the interposed methods; show the visit.
	st.restoreChat = interposeChat(chat, view);
	view.invalidate();
	tui.requestRender();
	return true;
}

/**
 * End the visit: unmount the view and restore the main session's stashed live
 * chat tree — including anything its run streamed while hidden.
 */
export function closeVisit(tui: TUI): boolean {
	const st = visitState();
	const v = st.visit;
	if (!v) return false;
	st.visit = undefined;
	// Undo the interposition and restore the stashed live tree in one step.
	st.restoreChat?.();
	st.restoreChat = undefined;
	if (v.footerSession !== undefined) {
		try {
			const footer = footerComponentOf(tui);
			footer?.setSession(v.footerSession);
		} catch {
			// best effort
		}
	}
	tui.requestRender();
	return true;
}

/** The visited session's background agent record (if any). */
export function visitAgent(): BgAgent | undefined {
	const st = visitState().visit;
	return st ? getAgent(st.id) : undefined;
}

/** Whether the visited session's background agent is running right now. */
export function visitRunning(): boolean {
	const a = visitAgent();
	return !!a && isRunning(a);
}
