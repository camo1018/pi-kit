import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";

const memoryTools = new Set([
	"memory_recall",
	"memory_get",
	"memory_list",
	"memory_count",
]);

/** Isolate synthetic trial data and prevent writes to durable memory. */
export default async function trial(pi: ExtensionAPI): Promise<void> {
	const dir = process.env.PI_WORKERS_TRIAL_DIR;
	if (!dir || resolve(dir) !== resolve(getAgentDir())) {
		throw new Error("Worker trial requires its isolated agent directory");
	}
	const extension = process.env.PI_WORKERS_TRIAL_BIGBRAIN;
	if (!extension) throw new Error("Worker trial needs the bigbrain bridge");
	const module = await import(extension);
	if (typeof module.default !== "function") {
		throw new Error("Invalid bigbrain extension factory");
	}
	// Keep the installed read tools, but don't persist this synthetic demo.
	const readOnly = new Proxy(pi, {
		get(target, key, receiver) {
			if (key === "on")
				return (event: string, ...args: unknown[]) => {
					if (event === "agent_settled") return () => {};
					return Reflect.apply(target.on, target, [event, ...args]);
				};
			if (key === "registerTool")
				return (tool: ToolDefinition) => {
					if (memoryTools.has(tool.name)) target.registerTool(tool);
				};
			return Reflect.get(target, key, receiver);
		},
	});
	await module.default(readOnly);

	pi.on("tool_call", (event) => {
		if (event.toolName === "session_workers") {
			if (event.input.action === "spawn") {
				const workers = resolve(dir, "session-workers/workers");
				let count = 0;
				try {
					count = readdirSync(workers).filter((name) =>
						name.endsWith(".json"),
					).length;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						throw error;
					}
				}
				if (count >= 2)
					return {
						block: true,
						reason: "Trial allows exactly two workers",
					};
			}
			return;
		}
		if (memoryTools.has(event.toolName)) return;
		if (event.toolName === "read") {
			const input = event.input as { path?: string };
			const file =
				typeof input.path === "string" ? resolve(dir, input.path) : "";
			if (
				["worker-a.md", "worker-b.md"].some(
					(name) => file === resolve(dir, "inputs", name),
				)
			)
				return;
		}
		return {
			block: true,
			reason:
				"Trial permits only fixture reads, " +
				"worker coordination, and read-only bigbrain access",
		};
	});
}
