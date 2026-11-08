/**
 * Terminals: the parts that are pure logic, without a native PTY.
 *
 * The ring buffer and the host lifecycle (resume, replace, reap) are where the
 * bugs would be, and both are exercisable with a stand-in for node-pty. A real
 * spawn is verified by hand, since it needs a login shell and a browser.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-term-"));
process.env.HOME = home;

const { depsDir, loadPty, Ring, shellCommand, TerminalHost, RING_BYTES } =
	await import("./terminal.ts");

/** A PTY stand-in: records writes, lets a test push output and kill it. */
function fakePty(pid = 4242) {
	const dataCbs: ((d: string) => void)[] = [];
	const exitCbs: ((e: { exitCode: number }) => void)[] = [];
	const pty = {
		pid,
		writes: [] as string[],
		sizes: [] as { cols: number; rows: number }[],
		killed: false,
		onData(cb: (d: string) => void) {
			dataCbs.push(cb);
		},
		onExit(cb: (e: { exitCode: number }) => void) {
			exitCbs.push(cb);
		},
		write(d: string) {
			pty.writes.push(d);
		},
		resize(cols: number, rows: number) {
			pty.sizes.push({ cols, rows });
		},
		kill() {
			pty.killed = true;
		},
		emit(d: string) {
			for (const cb of dataCbs) cb(d);
		},
		exit(code = 0) {
			for (const cb of exitCbs) cb({ exitCode: code });
		},
	};
	return pty;
}

/** An SSE response stand-in: enough surface for attach()/close() to write to. */
function fakeRes() {
	const res: any = {
		written: [] as string[],
		writableEnded: false,
		destroyed: false,
		headers: undefined as any,
		handlers: {} as Record<string, () => void>,
		writeHead(_s: number, h: any) {
			res.headers = h;
			return res;
		},
		write(c: string) {
			res.written.push(c);
			return true;
		},
		end() {
			res.writableEnded = true;
		},
		on(ev: string, cb: () => void) {
			res.handlers[ev] = cb;
			return res;
		},
		body() {
			return res.written.join("");
		},
		events() {
			return res.written
				.filter((w: string) => w.startsWith("data: "))
				.map((w: string) => JSON.parse(w.slice(6)));
		},
	};
	return res;
}

test("ring keeps order, sequence numbers and a byte ceiling", () => {
	const ring = new Ring();
	assert.equal(ring.lastSeq, 0);
	const a = ring.push(Buffer.from("one"));
	const b = ring.push(Buffer.from("two"));
	assert.deepEqual([a.seq, b.seq], [1, 2]);
	assert.equal(ring.firstSeq, 1);
	assert.equal(Buffer.from(b.b64, "base64").toString(), "two");

	// A resume after nothing is a full replay, not a truncation.
	assert.deepEqual(ring.since(0).chunks.map((c) => c.seq), [1, 2]);
	assert.equal(ring.since(0).truncated, false);
	// A resume mid-stream returns only what the client is missing.
	assert.deepEqual(ring.since(1).chunks.map((c) => c.seq), [2]);
	// A resume from the head is empty, and still not a truncation.
	assert.deepEqual(ring.since(2).chunks, []);
	assert.equal(ring.since(2).truncated, false);
});

test("ring drops from the front and reports the loss on resume", () => {
	const ring = new Ring();
	// Six chunks over a quarter-ceiling each: the front ones must fall off.
	const quarter = Math.floor(RING_BYTES / 4) + 1024;
	for (let i = 0; i < 6; i++) ring.push(Buffer.alloc(quarter, 0x61 + i));
	assert.ok(ring.size <= RING_BYTES, `size ${ring.size} should stay bounded`);
	assert.ok(ring.firstSeq > 2, "the front should have been dropped");
	assert.equal(ring.lastSeq, 6);

	// A client that was at seq 1 no longer has a contiguous history: say so,
	// so the browser clears rather than stitching.
	const late = ring.since(1);
	assert.equal(late.truncated, true);
	assert.ok(late.chunks.length >= 1);
	// A client that is current gets nothing at all.
	assert.equal(ring.since(ring.lastSeq).truncated, false);
	assert.deepEqual(ring.since(ring.lastSeq).chunks, []);

	// Garbage from a query string is "everything you have", never a crash and
	// never an unbounded scan.
	for (const junk of [NaN, -1, -Infinity, Infinity, 1e308, 0.5]) {
		const r = ring.since(junk);
		assert.ok(Array.isArray(r.chunks), `since(${junk}) must return chunks`);
	}
});

test("output streams to each viewer as base64, and a resume replays", () => {
	const pty = fakePty();
	const host = new TerminalHost({ audit: () => {}, spawn: () => pty, enabled: true });
	const first = fakeRes();
	let info: any;
	return host
		.open({ cols: 100, rows: 30 })
		.then((opened) => {
			info = opened;
			assert.equal(info.pid, 4242);
			assert.equal(host.attach(first, info.id, 0), true);
			pty.emit("hello\r\n");
			assert.deepEqual(first.events().map((e: any) => e.seq), [1]);
			const text = Buffer.from(first.events()[0].data, "base64").toString();
			assert.equal(text, "hello\r\n");

			// A phone that slept and came back asks for what it missed.
			const second = fakeRes();
			host.attach(second, info.id, 1);
			assert.deepEqual(second.events(), []);
			pty.emit("more");
			assert.deepEqual(
				second.events().map((e: any) =>
					Buffer.from(e.data, "base64").toString()),
				["more"],
			);

			// A cold attach replays the scrollback from the ring.
			const cold = fakeRes();
			host.attach(cold, info.id, 0);
			const coldText = cold
				.events()
				.map((e: any) => Buffer.from(e.data, "base64").toString())
				.join("");
			assert.equal(coldText, "hello\r\nmore");
			host.dispose();
		});
});

test("opening again attaches to the live shell instead of orphaning it", async () => {
	const spawns: any[] = [];
	const host = new TerminalHost({
		audit: () => {},
		spawn: () => {
			const p = fakePty(1000 + spawns.length);
			spawns.push(p);
			return p;
		},
		enabled: true,
	});
	const a = await host.open({});
	const b = await host.open({});
	assert.equal(a.id, b.id, "a reload must not leave a second shell running");
	assert.equal(spawns.length, 1);

	// `fresh: true` is the explicit "restart the shell" path.
	const c = await host.open({ fresh: true });
	assert.notEqual(c.id, a.id);
	assert.equal(spawns.length, 2);
	assert.equal(spawns[0].killed, true);
	host.dispose();
});

test("detached shells are reaped; viewed ones are not", async () => {
	let now = 1_000_000;
	const host = new TerminalHost({
		audit: () => {},
		spawn: () => fakePty(),
		enabled: true,
		idleMs: 60_000,
		maxLifetimeMs: 10 * 60_000,
		now: () => now,
	});
	const term = await host.open({});
	const res = fakeRes();
	host.attach(res, term.id, 0);

	// Attached: a long time may pass.
	now += 5 * 60_000;
	host.sweep();
	assert.ok(host.current(), "an attached shell must survive the idle timer");

	// The phone closes the page: the shell is on borrowed time, then reaped.
	res.handlers.close();
	now += 61_000;
	host.sweep();
	assert.equal(host.current(), undefined);

	const again = await host.open({});
	assert.ok(again.id);
	// And eventually nothing outlives the hard cap.
	now += 11 * 60_000;
	host.sweep();
	assert.equal(host.current(), undefined);
	host.dispose();
});

test("a finished shell keeps its output readable, then is forgotten", async () => {
	let now = 0;
	const pty = fakePty();
	const host = new TerminalHost({
		audit: () => {},
		spawn: () => pty,
		enabled: true,
		idleMs: 60_000,
		now: () => now,
	});
	const opened = await host.open({});
	host.attach(fakeRes(), opened.id, 0);
	pty.emit("bye\r\n");
	pty.exit(3);

	// A late viewer still sees the output and the exit, then the stream ends.
	const late = fakeRes();
	host.attach(late, opened.id, 0);
	const body = late.body();
	const replayed = late
		.events()
		.map((e: any) => Buffer.from(e.data, "base64").toString())
		.join("");
	assert.equal(replayed, "bye\r\n", "replayed output");
	assert.ok(body.includes("event: exit"), "exit is reported");
	assert.ok(body.includes('"code":3'), "with the real code");
	assert.equal(late.writableEnded, true);

	// An exited shell is not "current": a reload starts a new one.
	now += 30_000;
	host.sweep();
	assert.equal(host.current(), undefined);
	// ...then is dropped.
	now += 61_000;
	host.sweep();
	assert.equal(host.attach(fakeRes(), opened.id, 0), false);
	host.dispose();
});

test("input and resize go to the PTY; a dead terminal is a 404", async () => {
	const pty = fakePty();
	const host = new TerminalHost({ audit: () => {}, spawn: () => pty, enabled: true });
	const term = await host.open({ cols: 80, rows: 24 });
	host.input(term.id, "ls\r");
	assert.deepEqual(pty.writes, ["ls\r"]);
	host.resize(term.id, 120, 40);
	assert.deepEqual(pty.sizes, [{ cols: 120, rows: 40 }]);

	// Nonsense sizes are clamped rather than handed to the PTY.
	host.resize(term.id, 0, 9999);
	assert.deepEqual(pty.sizes.at(-1), { cols: 20, rows: 200 });

	pty.exit(0);
	assert.throws(() => host.input(term.id, "x"), /no such terminal/);
	host.dispose();
});

test("terminals stay off unless the flag was set", async () => {
	const host = new TerminalHost({ audit: () => {}, spawn: () => fakePty() });
	assert.equal(host.allowed, false);
	await assert.rejects(() => host.open({}), /terminals are off/);
});

test("missing node-pty is a clear 503, not a crash", async () => {
	const host = new TerminalHost({
		audit: () => {},
		spawn: undefined,
		enabled: true,
	});
	// loadPty() will fail to resolve inside a test tree; the error must name the
	// install command rather than throwing something opaque.
	await assert.rejects(
		() => host.open({}),
		(e: any) => e.status === 503 && /npm install --prefix/.test(e.message),
	);
});

test("the shell defaults to a login shell, and ORCH_WEB_TERM_CMD overrides it", () => {
	const saved = process.env.ORCH_WEB_TERM_CMD;
	const savedShell = process.env.SHELL;
	try {
		delete process.env.ORCH_WEB_TERM_CMD;
		process.env.SHELL = "/bin/zsh";
		assert.deepEqual(shellCommand().args, ["-l"]);
		process.env.ORCH_WEB_TERM_CMD = "pi --login";
		const pinned = shellCommand();
		assert.deepEqual(pinned.args, ["-lc", "pi --login"]);
		assert.equal(pinned.command, "pi --login");
	} finally {
		if (saved === undefined) delete process.env.ORCH_WEB_TERM_CMD;
		else process.env.ORCH_WEB_TERM_CMD = saved;
		if (savedShell === undefined) delete process.env.SHELL;
		else process.env.SHELL = savedShell;
	}
});

test("deps live outside the checkout by default, and honour ORCH_WEB_DEPS", () => {
	const saved = process.env.ORCH_WEB_DEPS;
	try {
		delete process.env.ORCH_WEB_DEPS;
		assert.equal(depsDir(), path.join(home, ".pi", "agent", "orch-web-deps"));
		process.env.ORCH_WEB_DEPS = "/tmp/elsewhere";
		assert.equal(depsDir(), "/tmp/elsewhere");
	} finally {
		if (saved === undefined) delete process.env.ORCH_WEB_DEPS;
		else process.env.ORCH_WEB_DEPS = saved;
	}
});

test("dispose kills every shell and ends every viewer stream", async () => {
	// The bug this guards: dispose() used to kill nothing, so a daemon restart
	// left login shells running, and an open SSE stream kept server.close()
	// from ever completing.
	const ptys: any[] = [];
	const host = new TerminalHost({
		audit: () => {},
		spawn: () => {
			const p = fakePty(2000 + ptys.length);
			ptys.push(p);
			return p;
		},
		enabled: true,
	});
	const term = await host.open({});
	const viewer = fakeRes();
	host.attach(viewer, term.id, 0);
	assert.equal(viewer.writableEnded, false);

	host.dispose();

	for (const pty of ptys) assert.equal(pty.killed, true, "shell must be killed");
	assert.equal(viewer.writableEnded, true, "stream must be ended, not orphaned");
	assert.equal(host.current(), undefined);
});

test("closing a terminal ends its stream and stops its heartbeat", async () => {
	const host = new TerminalHost({
		audit: () => {},
		spawn: () => fakePty(),
		enabled: true,
	});
	const term = await host.open({});
	const viewer = fakeRes();
	host.attach(viewer, term.id, 0);
	host.close(term.id, "requested");
	assert.equal(viewer.writableEnded, true);
	assert.ok(viewer.body().includes("event: close"), "client is told why");
	assert.equal(host.attach(fakeRes(), term.id, 0), false, "gone");
});

test("the shell never inherits the daemon's bearer token", async () => {
	// A shell can read its environment, so handing it ORCH_WEB_TOKEN would make
	// the token survive rotating the token file: `echo $ORCH_WEB_TOKEN` would
	// keep working long after the phone was revoked.
	const saved = process.env.ORCH_WEB_TOKEN;
	process.env.ORCH_WEB_TOKEN = "super-secret-daemon-token";
	let seen: Record<string, string | undefined> | undefined;
	try {
		const host = new TerminalHost({
			audit: () => {},
			spawn: (_f, _a, opts) => {
				seen = opts.env;
				return fakePty();
			},
			enabled: true,
		});
		await host.open({});
		assert.ok(seen, "spawn must have been called");
		assert.equal(
			"ORCH_WEB_TOKEN" in seen!,
			false,
			"the token must be absent from the child environment",
		);
		// Everything else survives: this is not a blank environment.
		assert.ok(
			Object.keys(seen!).length > 0,
			"the shell still needs the daemon's environment",
		);
		// The inbox markers must not leak either.
		assert.equal("PI_INBOX_BG_AGENT" in seen!, false);
		assert.equal("PI_INBOX_BG_PARENT" in seen!, false);
		host.dispose();
	} finally {
		if (saved === undefined) delete process.env.ORCH_WEB_TOKEN;
		else process.env.ORCH_WEB_TOKEN = saved;
	}
});

test("a terminal records the remote it was opened from", async () => {
	const seen: any[] = [];
	const host = new TerminalHost({
		audit: (event, detail) => seen.push({ event, detail }),
		spawn: () => fakePty(),
		enabled: true,
	});
	const term = await host.open({ remote: "192.168.1.9" });
	assert.equal(term.pid, 4242);
	const open = seen.find((s) => s.event === "term-open");
	assert.equal(open.detail.remote, "192.168.1.9");
	host.close(term.id, "requested");
	const close = seen.find((s) => s.event === "term-close");
	assert.equal(close.detail.reason, "requested");
});
