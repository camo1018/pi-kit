import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import planModeExtension from "./index.ts";

test("headless agents save plans for later execution", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	});

	type Handler = (...args: any[]) => Promise<any>;
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Handler>();
	const entries: Array<{ customType: string; data: any }> = [];
	const sent: Array<{ message: any; options: any }> = [];
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		appendEntry(customType: string, data: any) {
			entries.push({ customType, data });
		},
		getActiveTools: () => activeTools,
		getFlag: (name: string) => name === "plan",
		on(name: string, handler: (...args: any[]) => Promise<any>) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command.handler);
		},
		registerFlag() {},
		registerShortcut() {},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
		},
		sendUserMessage() {},
		setActiveTools(tools: string[]) {
			activeTools = tools;
		},
	};
	planModeExtension(pi as any);

	const ctx = {
		cwd: "/work/headless-project",
		hasUI: false,
		sessionManager: {
			getEntries: () => [],
			getSessionId: () => "headless-session-123",
		},
		ui: {
			notify() {},
			setStatus() {},
			setWidget() {},
			theme: {
				fg: (_role: string, value: string) => value,
				strikethrough: (value: string) => value,
			},
		},
	};
	await handlers.get("session_start")!({}, ctx);
	assert.doesNotMatch(activeTools.join(","), /edit|write/);

	await handlers.get("agent_end")!(
		{
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Plan:\n1. Inspect all callers\n2. Implement safely",
						},
					],
				},
			],
		},
		ctx,
	);

	const state = entries.at(-1)?.data;
	assert.equal(state.enabled, true);
	assert.equal(state.todos.length, 2);
	assert.match(state.planFile, /headless-project\/.*\.md$/);
	assert.match(await readFile(state.planFile, "utf8"), /Inspect all callers/);
	assert.match(sent.at(-1)?.message.content, /Take over this session/);

	await commands.get("plan-execute")!("", ctx);
	assert.deepEqual(activeTools, ["read", "bash", "edit", "write"]);
	assert.equal(entries.at(-1)?.data.executing, true);
	assert.equal(sent.at(-1)?.options.triggerTurn, true);
});
