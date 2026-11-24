import assert from "node:assert/strict";
import { test } from "node:test";

const { feedAnswer } = await import("./index.ts");

const list = () => ({ mode: "list" as const, optCursor: 0, draft: "" });
const CAN = { canAnswer: true, optionCount: 3 };
const NO = { canAnswer: false, optionCount: 0 };

test("a opens text mode, typing builds a draft, enter answers", () => {
	let st = list();
	let step = feedAnswer(st, "a", CAN);
	assert.equal(step.state.mode, "text");
	st = step.state;
	for (const ch of ["B", " ", "ok"]) st = feedAnswer(st, ch, CAN).state;
	assert.equal(st.draft, "B ok");
	step = feedAnswer(st, "\r", CAN);
	assert.deepEqual(step.done, { answer: "B ok" });
	assert.equal(step.state.mode, "list", "returns to list after answering");
});

test("text mode: esc returns to the list and discards the draft", () => {
	let st = feedAnswer(list(), "a", CAN).state;
	st = feedAnswer(st, "x", CAN).state;
	const step = feedAnswer(st, "\u001b", CAN);
	assert.equal(step.state.mode, "list");
	assert.equal(step.state.draft, "");
	assert.equal(step.done, undefined);
});

test("text mode: enter on an empty draft does not answer", () => {
	const step = feedAnswer({ mode: "text", optCursor: 0, draft: "   " }, "\r", CAN);
	assert.equal(step.done, undefined, "whitespace-only must not answer");
	assert.equal(step.state.mode, "list");
});

test("backspace edits the draft", () => {
	let st = feedAnswer(list(), "a", CAN).state;
	st = feedAnswer(st, "ab", CAN).state;
	st = feedAnswer(st, "\u007f", CAN).state;
	assert.equal(st.draft, "a");
});

test("o opens option mode and enter picks the highlighted option", () => {
	let st = feedAnswer(list(), "o", CAN).state;
	assert.equal(st.mode, "option");
	const step = feedAnswer(st, "\r", CAN);
	assert.deepEqual(step.done, { answer: "0" }, "index 0 = first option");
});

test("option mode: arrows move the cursor and are clamped", () => {
	let st = feedAnswer(list(), "o", CAN).state;
	st = feedAnswer(st, "j", CAN).state;
	assert.equal(st.optCursor, 1);
	st = feedAnswer(st, "j", CAN).state;
	st = feedAnswer(st, "j", CAN).state;
	st = feedAnswer(st, "j", CAN).state;
	assert.equal(st.optCursor, 2, "clamped to the last option");
	st = feedAnswer(st, "k", CAN).state;
	assert.equal(st.optCursor, 1);
});

test("number keys answer directly with that option", () => {
	assert.deepEqual(feedAnswer(list(), "1", CAN).done, { answer: "0" });
	assert.deepEqual(feedAnswer(list(), "3", CAN).done, { answer: "2" });
});

test("an out-of-range number does nothing", () => {
	assert.equal(feedAnswer(list(), "9", { canAnswer: true, optionCount: 3 }).done, undefined);
});

test("q and esc close the screen from the list", () => {
	assert.equal(feedAnswer(list(), "q", CAN).close, true);
	assert.equal(feedAnswer(list(), "\u001b", CAN).close, true);
});

test("on an answered question, answer keys do nothing", () => {
	assert.equal(feedAnswer(list(), "a", NO).state.mode, "list");
	assert.equal(feedAnswer(list(), "o", NO).state.mode, "list");
	assert.equal(feedAnswer(list(), "1", NO).done, undefined);
});

test("up/down in list mode report a move instead of being swallowed", () => {
	assert.equal(feedAnswer(list(), "k", CAN).move, "up");
	assert.equal(feedAnswer(list(), "j", CAN).move, "down");
});
