import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	installAgentChildHooks,
	isAgentChild,
} from "../../lib/inbox-agents.ts";
import { installBackgroundMcpAutoApproval } from "../../lib/background-mcp-approval.ts";
import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import { bounded, WorkerTeam } from "./workers.ts";

const CUSTOM_TYPE = "pi-kit:worker-notes";
const actions = [
	"spawn",
	"list",
	"read",
	"wait",
	"send",
	"cancel",
	"share",
	"notes",
] as const;
const Parameters = Type.Object({
	action: StringEnum(actions),
	id: Type.Optional(Type.String({ description: "Worker session id" })),
	title: Type.Optional(Type.String({ maxLength: 200 })),
	task: Type.Optional(Type.String({ maxLength: 32_000 })),
	context: Type.Optional(
		Type.String({
			maxLength: 32_000,
			description: "Explicit handoff; history is not cloned",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Worker directory/worktree; defaults to parent's cwd",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"provider/model[:thinking]; defaults to parent's model",
		}),
	),
	text: Type.Optional(
		Type.String({
			maxLength: 32_000,
			description: "Follow-up message, or shared note (max 4000 chars)",
		}),
	),
	seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
});

/** The runner is injectable so tests never launch real model processes. */
export function registerSessionWorkers(
	pi: ExtensionAPI,
	team = new WorkerTeam(getAgentDir()),
): void {
	registerLoadedExtension("session-workers");
	const extensionPath = fileURLToPath(import.meta.url);

	pi.on("session_start", (_event, ctx) => {
		if (process.env.BIGBRAIN_MAINT === "1") return;
		installBackgroundMcpAutoApproval(pi);
		installAgentChildHooks((name) => pi.setSessionName(name));
		const caller = ctx.sessionManager.getSessionId();
		if (
			(ctx.mode === "tui" || isAgentChild()) &&
			team.parent(caller) === caller
		) {
			team.supervise(caller);
		}
	});

	pi.on("context", (event, ctx) => {
		if (process.env.BIGBRAIN_MAINT === "1") return;
		const content = team.context(ctx.sessionManager.getSessionId());
		const messages = event.messages.filter(
			(message) =>
				!(
					message.role === "custom" &&
					message.customType === CUSTOM_TYPE
				),
		);
		if (content) {
			messages.push({
				role: "custom",
				customType: CUSTOM_TYPE,
				content,
				display: false,
				timestamp: Date.now(),
			});
		}
		// Request-only: notes aren't persisted or re-ingested as new memories.
		return { messages };
	});

	pi.registerTool({
		name: "session_workers",
		label: "Session Workers",
		description:
			"Delegate parallel work to persistent Pi sessions. " +
			"spawn returns immediately; list/read show results, wait waits " +
			"up to 60 seconds for one worker or the team. send queues a " +
			"follow-up (not mid-run steering); cancel clears its queue. " +
			"share publishes a team note; notes reads the shared board. " +
			"Only the parent may spawn/send/cancel. Workers can read " +
			"siblings and share notes. Children inherit the inbox group. " +
			"Foreground and background parents can delegate one level; " +
			"delegated workers cannot spawn another generation.",
		promptGuidelines: [
			"Use session_workers for independent tasks when parallel work " +
				"helps. Give workers explicit scope, context, and deliverables.",
			"Use separate worktrees for concurrent code edits; otherwise " +
				"assign disjoint files or read-only tasks. Do not delegate " +
				"commits, pushes, or external writes without authorization.",
			"Shared notes refresh on model requests, not during a running " +
				"tool. An idle worker may be blocked; inspect its reply. " +
				"Check all worker results before declaring the task complete.",
		],
		parameters: Parameters,
		executionMode: "sequential",
		async execute(_callId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const caller = ctx.sessionManager.getSessionId();
			const result = (data: unknown) => ({
				content: [
					{
						type: "text" as const,
						text: bounded(JSON.stringify(data, null, 2), 40_000),
					},
				],
				details: { action: params.action, data },
			});
			const id = () => {
				if (!params.id) throw new Error("This action requires id");
				return params.id;
			};
			const statuses = () =>
				params.id
					? [team.status(caller, params.id)]
					: team
							.workers(caller)
							.map((worker) => team.status(caller, worker.id));
			switch (params.action) {
				case "spawn": {
					if (process.env.BIGBRAIN_MAINT === "1") {
						throw new Error(
							"Memory maintenance cannot spawn workers",
						);
					}
					if (!params.task || !params.title) {
						throw new Error("Spawn requires task and title");
					}
					const model =
						params.model ??
						(ctx.model
							? `${ctx.model.provider}/${ctx.model.id}:` +
								ctx.thinkingLevel
							: undefined);
					const worker = await team.spawn({
						parentId: caller,
						task: params.task,
						title: params.title,
						context: params.context,
						model,
						cwd: path.resolve(ctx.cwd, params.cwd ?? "."),
						extensionPath,
					});
					return result(team.status(caller, worker.id));
				}
				case "list":
					return result(statuses());
				case "read":
					return result(team.status(caller, id()));
				case "send":
					team.send(caller, id(), params.text ?? "");
					return result(team.status(caller, id()));
				case "cancel":
					team.cancel(caller, id());
					return result(team.status(caller, id()));
				case "share":
					return result(team.share(caller, params.text ?? ""));
				case "notes":
					return result({
						notes: team.notes(caller).slice(-24),
						files: path.join(
							team.root,
							"notes",
							team.parent(caller),
						),
					});
				case "wait": {
					const deadline = Date.now() + (params.seconds ?? 30) * 1000;
					let workers = statuses();
					const active = () =>
						workers.some(
							(worker) =>
								worker.busy ||
								worker.state === "queued" ||
								worker.state === "working" ||
								worker.state === "unknown",
						);
					while (active() && Date.now() < deadline) {
						await delay(250, undefined, { signal });
						workers = statuses();
					}
					return result({ timedOut: active(), workers });
				}
			}
		},
	});
}

export default function sessionWorkers(pi: ExtensionAPI): void {
	registerSessionWorkers(pi);
}
