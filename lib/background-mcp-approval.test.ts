import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	installBackgroundMcpAutoApproval,
	isMcpToolAllowlisted,
	parseMcpApprovalConfig,
	parseMcpAllowlist,
	shouldAutoApproveMcpTool,
} from "./background-mcp-approval.ts";

const readRequest = {
	serverName: "github",
	originalToolName: "get_pull_request",
};
const writeRequest = {
	serverName: "github",
	originalToolName: "merge_pull_request",
};

test("parses only non-empty server/tool allowlist patterns", () => {
	assert.deepEqual(
		parseMcpAllowlist({
			tools: [" github/get_* ", "bad", 42, "/missing", "missing/"],
		}),
		["github/get_*"],
	);
	assert.deepEqual(parseMcpAllowlist(["github/*"]), []);
});

test("allowlist is the default and unknown modes fail closed", () => {
	assert.deepEqual(parseMcpApprovalConfig({}), {
		mode: "allowlist",
		patterns: [],
	});
	assert.deepEqual(parseMcpApprovalConfig({ mode: "unknown" }), {
		mode: "allowlist",
		patterns: [],
	});
	assert.deepEqual(
		parseMcpApprovalConfig({
			mode: "allowlist",
			tools: ["github/get_*"],
		}),
		{ mode: "allowlist", patterns: ["github/get_*"] },
	);
});

test("auto-approval supports allowlist and explicit allow-all modes", () => {
	const patterns = ["github/get_*", "docs/search"];
	const allowlist = { mode: "allowlist" as const, patterns };
	const allowAll = { mode: "allow-all" as const, patterns: [] };

	assert.equal(isMcpToolAllowlisted(readRequest, patterns), true);
	assert.equal(isMcpToolAllowlisted(writeRequest, patterns), false);
	assert.equal(shouldAutoApproveMcpTool(readRequest, allowlist), true);
	assert.equal(shouldAutoApproveMcpTool(writeRequest, allowlist), false);
	assert.equal(shouldAutoApproveMcpTool(writeRequest, allowAll), true);
	assert.equal(
		isMcpToolAllowlisted(
			{ serverName: "other", originalToolName: "get_pull_request" },
			patterns,
		),
		false,
	);
});

test("background approval follows live mode changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-kit-mcp-"));
	const allowlist = join(dir, "allowlist.json");
	writeFileSync(
		allowlist,
		JSON.stringify({ tools: ["github/get_*"] }),
	);
	let listener: ((request: unknown) => void) | undefined;
	const pi = {
		events: {
			on(_event: string, handler: (request: unknown) => void) {
				listener = handler;
				return () => {};
			},
		},
	};
	const env: Record<string, string | undefined> = {
		PI_INBOX_AUTO_APPROVE_MCP: "1",
		PI_INBOX_BG_AGENT: "agent",
		PI_INBOX_BG_PARENT: "123",
	};

	try {
		assert.equal(
			installBackgroundMcpAutoApproval(pi as any, env, allowlist),
			true,
		);
		assert.equal(env.PI_INBOX_AUTO_APPROVE_MCP, undefined);
		let claims = 0;
		const request = (tool: string) => ({
			serverName: "github",
			originalToolName: tool,
			claim() {
				claims++;
				return true;
			},
		});
		listener?.(request("merge_pull_request"));
		assert.equal(claims, 0);
		listener?.(request("get_pull_request"));
		assert.equal(claims, 1);

		writeFileSync(
			allowlist,
			JSON.stringify({ mode: "allow-all" }),
		);
		listener?.(request("merge_pull_request"));
		assert.equal(claims, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
