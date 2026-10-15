import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_MCP_AUTO_APPROVE_ENV =
	"PI_INBOX_AUTO_APPROVE_MCP";
export const BACKGROUND_MCP_ALLOWLIST_FILE =
	"inbox-mcp-allowlist.json";

const MCP_APPROVAL_EVENT =
	"pi-mcp-adapter:tool-approval-request";
const STATE_KEY = Symbol.for("pi.inbox.backgroundMcpApproval");

export type McpAllowlistRequest = {
	serverName: string;
	originalToolName: string;
	prefixedToolName?: string;
};

type ApprovalRequest = McpAllowlistRequest & {
	claim(handler: () => Promise<"allow_once">): boolean;
};

type ApprovalState = {
	enabled: boolean;
	unsubscribe?: () => void;
};

type AllowlistCache = {
	key: string;
	patterns: string[];
};

let allowlistCache: AllowlistCache | undefined;

function state(): ApprovalState {
	const globals = globalThis as any;
	return globals[STATE_KEY] ??=
		{ enabled: false } satisfies ApprovalState;
}

function defaultAgentDir(
	env: Record<string, string | undefined>,
): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) {
		return join(homedir(), configured.slice(2));
	}
	return configured;
}

export function parseMcpAllowlist(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return [];
	}
	const tools = (value as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return [];
	return tools
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => {
			const slash = item.indexOf("/");
			return slash > 0 && slash < item.length - 1;
		});
}

function readMcpAllowlist(file: string): string[] {
	let key = `${file}:missing`;
	try {
		const stat = statSync(file);
		key = `${file}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		// A missing allowlist intentionally approves nothing.
	}
	if (allowlistCache?.key === key) return allowlistCache.patterns;

	let patterns: string[] = [];
	try {
		patterns = parseMcpAllowlist(
			JSON.parse(readFileSync(file, "utf-8")),
		);
	} catch {
		// Invalid and unreadable allowlists fail closed.
	}
	allowlistCache = { key, patterns };
	return patterns;
}

function matchesGlob(value: string, pattern: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(value);
}

export function isMcpToolAllowlisted(
	request: McpAllowlistRequest,
	patterns: string[],
): boolean {
	const name = `${request.serverName}/${request.originalToolName}`;
	return patterns.some((pattern) => matchesGlob(name, pattern));
}

/**
 * Approve explicitly allowlisted MCP calls in orchestrator background-agent
 * children. The fixed allowlist is read on every call (mtime-cached), so edits
 * take effect without reloading Pi. Missing or invalid config fails closed.
 *
 * The one-shot environment flag is removed after startup so tools and nested
 * Pi processes cannot inherit the approval policy. Process-global state keeps
 * the policy if Pi reloads the extension during the same child process.
 */
export function installBackgroundMcpAutoApproval(
	pi: Pick<ExtensionAPI, "events">,
	env: Record<string, string | undefined> = process.env,
	allowlistFile = join(
		defaultAgentDir(env),
		BACKGROUND_MCP_ALLOWLIST_FILE,
	),
): boolean {
	const approvalState = state();
	const flagged =
		env[BACKGROUND_MCP_AUTO_APPROVE_ENV] === "1" &&
		!!env.PI_INBOX_BG_AGENT &&
		!!env.PI_INBOX_BG_PARENT;
	delete env[BACKGROUND_MCP_AUTO_APPROVE_ENV];

	if (flagged) approvalState.enabled = true;
	if (!approvalState.enabled) return false;

	approvalState.unsubscribe?.();
	approvalState.unsubscribe = pi.events.on(
		MCP_APPROVAL_EVENT,
		(data: unknown) => {
			const request = data as Partial<ApprovalRequest>;
			if (
				typeof request?.claim !== "function" ||
				typeof request.serverName !== "string" ||
				typeof request.originalToolName !== "string"
			) {
				return;
			}
			if (!isMcpToolAllowlisted(
				request as ApprovalRequest,
				readMcpAllowlist(allowlistFile),
			)) {
				return;
			}
			request.claim(async () => "allow_once");
		},
	);
	return true;
}
