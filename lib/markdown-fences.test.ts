import assert from "node:assert/strict";
import { test } from "node:test";
import { isClosingFence } from "./markdown-fences.ts";

const backticks = { char: "`", len: 3 };

test("accepts CommonMark closing fences indented by at most three spaces", () => {
	for (const line of ["```", " ```", "  ``` ", "   ````\t"]) {
		assert.equal(isClosingFence(line, backticks), true, line);
	}
});

test("does not treat indented code as a closing fence", () => {
	for (const line of ["    ```", "\t```", "   ~~", "~~~", "``` x"]) {
		assert.equal(isClosingFence(line, backticks), false, line);
	}
});
