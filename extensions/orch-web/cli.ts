/**
 * `orch-web` — start the phone front end for the inbox.
 *
 *   orch-web                       serve on the LAN address (:8787)
 *   orch-web --pair                print a URL, QR and 6-digit code for a phone
 *   ORCH_WEB_TOKEN=…               set the token instead of using the token file
 *   ORCH_WEB_HOST / _PORT          override the bind address / port
 *   ORCH_WEB_HOSTS                 extra accepted Host headers (comma separated)
 *   ORCH_WEB_ALLOW_TERM=1          offer a PTY on /terminal (see terminal.ts)
 *   ORCH_WEB_TERM_CMD              pin that PTY to one command instead of $SHELL -l
 *   ORCH_WEB_DEPS                  where the out-of-tree node-pty lives
 *
 * The token is a bearer credential for a shell on this machine: anyone on the
 * same wifi who has it can run commands through pi. It lives in
 * ~/.pi/agent/orch-web-token (mode 0600) and never in the repo. Phones never see
 * it typed by hand: `--pair` mints a single-use 6-digit code, and the phone
 * trades that code for the token.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lanAddress, mintPairCode, startOrchWeb } from "./server.ts";

const TOKEN_PATH = path.join(getAgentDir(), "orch-web-token");

function ensureToken(): string {
	const fromEnv = process.env.ORCH_WEB_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	try {
		const existing = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
		if (existing.length >= 16) return existing;
	} catch {
		// generate below
	}
	const token = randomBytes(24).toString("hex");
	fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
	fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
	return token;
}

const token = ensureToken();
process.env.ORCH_WEB_TOKEN = token;

const port = Number(process.env.ORCH_WEB_PORT ?? 8787);
const host = process.env.ORCH_WEB_HOST ?? lanAddress();

function baseHosts(extra?: string): string[] {
	return [
		host,
		"localhost",
		"127.0.0.1",
		os.hostname(),
		`${os.hostname()}.local`,
		...((extra ?? "").split(/[\s,]+/).filter(Boolean)),
	].map((h) => h.toLowerCase());
}

/** A terminal QR via `qrencode` when present; the URL alone when it is not. */
function renderQr(text: string): string[] | undefined {
	const qr = spawnSync("qrencode", ["-t", "ANSIUTF8", "-m", "1", text], {
		encoding: "utf-8",
	});
	if (qr.error || qr.status !== 0 || !qr.stdout) return undefined;
	return qr.stdout.replace(/\n+$/, "").split("\n");
}

/**
 * Mint a pairing code and print it. This works whether or not the daemon is
 * running: the code goes to a file the server reads, so it does not need to own
 * the port or be the same process (launchd restarts it independently).
 */
function pair() {
	const { code, expires } = mintPairCode(getAgentDir());
	const page = `http://${host}:${port}/`;
	const alternate = `http://${os.hostname()}.local:${port}/`;
	const minutes = Math.max(1, Math.round((expires - Date.now()) / 60_000));

	console.log("On the phone, open this and enter the code:\n");
	console.log(`  ${page}`);
	console.log(`  ${alternate}   (usually works when the IP changes)\n`);
	console.log(`  code: ${code}   · valid ${minutes} min · single use\n`);

	const qr = renderQr(page);
	if (qr) {
		console.log("or scan this:");
		for (const line of qr) console.log(`  ${line}`);
	} else {
		console.log("(brew install qrencode to also print a scannable code)\n");
	}

	if (!isServing()) {
		console.log(
			`note: nothing is listening on ${port} yet — start it with ` +
				"`./scripts/orch-web.sh` or `./scripts/orch-web-install.sh`.",
		);
	}
}

/** Best-effort check that something already holds the port. */
function isServing(): boolean {
	const probe = spawnSync(
		process.execPath,
		[
			"-e",
			`const s=require("node:net").createServer();
			 s.once("error",()=>process.exit(1));
			 s.listen(${port},"${host}",()=>s.close(()=>process.exit(0)));`,
		],
		{ timeout: 3000 },
	);
	return probe.status === 1;
}

if (process.argv.includes("--pair")) {
	pair();
} else {
	const server = startOrchWeb({
		host,
		port,
		token,
		hosts: baseHosts(process.env.ORCH_WEB_HOSTS),
	});
	const stop = () => server.close(() => process.exit(0));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
