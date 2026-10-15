import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdownFences } from "./index.ts";

test("a four-space-indented fence does not close rendered Markdown", () => {
	const markdown = [
		"```md",
		"before",
		"    ```",
		"after",
		"```",
		"tail",
	].join("\n");

	assert.equal(
		renderMarkdownFences(markdown),
		[
			"┌─ *rendered markdown*",
			"",
			"before",
			"    ```",
			"after",
			"",
			"└─",
			"tail",
		].join("\n"),
	);
});
