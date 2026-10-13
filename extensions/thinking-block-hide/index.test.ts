import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomEditor,
	initTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import thinkingBlockHide from "./index.ts";

initTheme("dark");

const pi = {
	on() {},
	registerCommand() {},
} as unknown as ExtensionAPI;
thinkingBlockHide(pi);

const state = (globalThis as any)[
	Symbol.for("pi.ext.thinking-block-hide")
] as {
	mode: "visible" | "collapsed" | "hidden";
	cycle?: () => void;
};

function message(
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("cycles render state without changing the source message", () => {
	state.mode = "collapsed";
	const source = message([
		{ type: "thinking", thinking: "private reasoning" },
		{ type: "text", text: "final answer" },
	]);
	const component = new AssistantMessageComponent(source, true);

	assert.match(component.render(80).join("\n"), /Thinking\.\.\./);

	state.mode = "hidden";
	const hidden = component.render(80).join("\n");
	assert.doesNotMatch(hidden, /Thinking|private reasoning/);
	assert.match(hidden, /final answer/);
	assert.equal(source.content.length, 2);

	state.mode = "visible";
	assert.match(component.render(80).join("\n"), /private reasoning/);
});

test("hidden thinking-only messages occupy no transcript rows", () => {
	state.mode = "hidden";
	const component = new AssistantMessageComponent(
		message([
			{ type: "thinking", thinking: "private reasoning" },
		]),
		true,
	);

	assert.deepEqual(component.render(80), []);
});

test("ctrl+t uses the extension cycle instead of Pi's toggle", () => {
	let cycles = 0;
	let nativeToggles = 0;
	state.cycle = () => {
		cycles++;
	};
	const editor = {
		actionHandlers: new Map([
			["app.thinking.toggle", () => nativeToggles++],
		]),
		keybindings: {
			matches: (_data: string, action: string) =>
				action === "app.thinking.toggle",
		},
	};

	CustomEditor.prototype.handleInput.call(
		editor as unknown as CustomEditor,
		"ctrl+t",
	);

	assert.equal(cycles, 1);
	assert.equal(nativeToggles, 0);
	state.cycle = undefined;
});
