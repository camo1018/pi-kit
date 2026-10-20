import assert from "node:assert/strict";
import { test } from "node:test";
import commandCase, { canonicalizeCommandText } from "./index.ts";

function makePi(commands: string[] = [], handlers = new Map<string, any>()) {
	const pi: any = {
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
	};
	if (commands.length > 0) pi.getCommands = () => commands.map((name) => ({ name, source: "extension" }));
	return { pi, handlers, commands };
}

function makeCtx(mode = "tui", commands: string[] = []) {
	return {
		mode,
		getCommands: () => commands.map((name) => ({ name, source: "extension" })),
		ui: {
			setEditorComponent: (factory: any) => {
				// no-op for tests; we only assert it is called in tui mode
			},
		},
	};
}

test("canonicalizes builtin commands regardless of casing", () => {
	const { pi, handlers } = makePi();
	commandCase(pi);
	const ctx = makeCtx("tui");
	handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(canonicalizeCommandText("/RELOAD"), "/reload");
	assert.equal(canonicalizeCommandText("/QUIT"), "/quit");
	assert.equal(canonicalizeCommandText("/Model"), "/model");
});

test("keeps args untouched", () => {
	const { pi, handlers } = makePi();
	commandCase(pi);
	handlers.get("session_start")({ type: "session_start", reason: "startup" }, makeCtx("tui"));
	assert.equal(canonicalizeCommandText("/MODEL Sonnet 4"), "/model Sonnet 4");
	assert.equal(canonicalizeCommandText("/NAME Keep CAPS"), "/name Keep CAPS");
});

test("canonicalizes extension, prompt, and skill commands", () => {
	const { pi, handlers } = makePi(["MyCommand", "skill:Grafana"]);
	commandCase(pi);
	handlers.get("session_start")(
		{ type: "session_start", reason: "startup" },
		makeCtx("tui"),
	);
	assert.equal(canonicalizeCommandText("/MYCOMMAND"), "/MyCommand");
	assert.equal(canonicalizeCommandText("/SKILL:GRAFANA"), "/skill:Grafana");
});

test("passes unknown commands and non-commands through", () => {
	const { pi, handlers } = makePi();
	commandCase(pi);
	handlers.get("session_start")({ type: "session_start", reason: "startup" }, makeCtx("tui"));
	assert.equal(canonicalizeCommandText("/NOSUCHCOMMAND"), "/NOSUCHCOMMAND");
	assert.equal(canonicalizeCommandText("hello /reload"), "hello /reload");
	assert.equal(canonicalizeCommandText("//host/path"), "//host/path");
	assert.equal(canonicalizeCommandText("/file/name.json"), "/file/name.json");
	assert.equal(canonicalizeCommandText(""), "");
});

test("only rewrites the first line of multi-line input", () => {
	const { pi, handlers } = makePi();
	commandCase(pi);
	handlers.get("session_start")({ type: "session_start", reason: "startup" }, makeCtx("tui"));
	const input = "/MODEL pick one\nsecond /RELOAD line";
	assert.equal(
		canonicalizeCommandText(input),
		"/model pick one\nsecond /RELOAD line",
	);
});

test("installs editor only in tui mode", () => {
	const { pi, handlers } = makePi();
	commandCase(pi);
	let installed = false;
	const ctx: any = makeCtx("tui");
	ctx.ui.setEditorComponent = () => {
		installed = true;
	};
	handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	assert.ok(installed, "tui mode installs the editor");

	const { handlers: h2 } = makePi();
	const pi2: any = { on: (_: string, handler: any) => h2.set("session_start", handler) };
	commandCase(pi2);
	let installed2 = false;
	const ctx2: any = makeCtx("json");
	ctx2.ui.setEditorComponent = () => {
		installed2 = true;
	};
	h2.get("session_start")({ type: "session_start", reason: "startup" }, ctx2);
	assert.ok(!installed2, "non-tui mode does not install the editor");
});

test("fail-soft: missing or throwing getCommands never breaks submit", () => {
	// pi without getCommands at all (the crash shape)
	const handlers = new Map<string, any>();
	const bare: any = { on: (_: string, h: any) => handlers.set("session_start", h) };
	commandCase(bare);
	handlers.get("session_start")({ type: "session_start", reason: "startup" }, makeCtx("tui"));
	assert.equal(canonicalizeCommandText("/RELOAD"), "/reload", "builtins still work");
	assert.equal(canonicalizeCommandText("/ORPHAN"), "/ORPHAN", "unknown passes through");

	// pi whose getCommands throws
	const throwing: any = { on: (_: string, h: any) => handlers.set("session_start", h) };
	throwing.getCommands = () => {
		throw new Error("boom");
	};
	commandCase(throwing);
	handlers.get("session_start")({ type: "session_start", reason: "startup" }, makeCtx("tui"));
	assert.equal(canonicalizeCommandText("/RELOAD"), "/reload", "builtins still work");
	assert.equal(canonicalizeCommandText("/ORPHAN"), "/ORPHAN", "unknown passes through");
});
