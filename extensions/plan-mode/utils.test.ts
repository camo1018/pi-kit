import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPlanText, extractTodoItems } from "./utils.ts";

test("extracts the full untruncated plan for durable storage", () => {
	const message = [
		"I inspected the relevant files.",
		"",
		"**Plan:**",
		"1. Update the background workflow with all required details",
		"   - Preserve this nested detail in the saved plan.",
		"2. Verify behavior in TUI and JSON modes",
	].join("\n");

	assert.equal(
		extractPlanText(message),
		[
			"Plan:",
			"1. Update the background workflow with all required details",
			"   - Preserve this nested detail in the saved plan.",
			"2. Verify behavior in TUI and JSON modes",
		].join("\n"),
	);

	assert.deepEqual(extractTodoItems(message), [
		{
			step: 1,
			text: "Background workflow with all required details",
			completed: false,
		},
		{
			step: 2,
			text: "Behavior in TUI and JSON modes",
			completed: false,
		},
	]);
});

test("returns no plan when the assistant omitted the required header", () => {
	assert.equal(extractPlanText("1. This is only a list"), undefined);
	assert.deepEqual(extractTodoItems("1. This is only a list"), []);
});
