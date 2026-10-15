import assert from "node:assert/strict";
import { test } from "node:test";
import { scanFences } from "./index.ts";

test("a four-space-indented fence stays inside the copied block", () => {
	const markdown = [
		"```md",
		"before",
		"    ```",
		"after",
		"```",
		"tail",
	].join("\n");

	assert.deepEqual(scanFences(markdown), [{
		lang: "md",
		code: "before\n    ```\nafter",
		closeLine: 4,
		indent: "",
	}]);
});
