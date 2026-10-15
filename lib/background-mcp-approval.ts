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

export type BackgroundMcpApprovalConfig = {
	mode: "allowlist" | "allow-all";
	patterns: string[];
};

type AllowlistCache = {
	key: string;
	config: BackgroundMcpApprovalConfig;
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

export function parseMcpApprovalConfig(
	value: unknown,
): BackgroundMcpApprovalConfig {
	const fallback: BackgroundMcpApprovalConfig = {
		mode: "allowlist",
		patterns: [],
	};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return fallback;
	}
	const input = value as { mode?: unknown; tools?: unknown };
	if (input.mode === "allow-all") {
		return { mode: "allow-all", patterns: [] };
	}
	if (input.mode !== undefined && input.mode !== "allowlist") {
		return fallback;
	}
	if (!Array.isArray(input.tools)) return fallback;
	const patterns = input.tools
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => {
			const slash = item.indexOf("/");
			return slash > 0 && slash < item.length - 1;
		});
	return { mode: "allowlist", patterns };
}

export function parseMcpAllowlist(value: unknown): string[] {
	return parseMcpApprovalConfig(value).patterns;
}

function readMcpApprovalConfig(
	file: string,
): BackgroundMcpApprovalConfig {
	let key = `${file}:missing`;
	try {
		const stat = statSync(file);
		key = `${file}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		// A missing allowlist intentionally approves nothing.
	}
	if (allowlistCache?.key === key) return allowlistCache.config;

	let config: BackgroundMcpApprovalConfig = {
		mode: "allowlist",
		patterns: [],
	};
	try {
		config = parseMcpApprovalConfig(
			JSON.parse(readFileSync(file, "utf-8")),
		);
	} catch {
		// Invalid and unreadable config files fail closed.
	}
	allowlistCache = { key, config };
	return config;
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

export function shouldAutoApproveMcpTool(
	request: McpAllowlistRequest,
	config: BackgroundMcpApprovalConfig,
): boolean {
	return config.mode === "allow-all" ||
		isMcpToolAllowlisted(request, config.patterns);
}

/**
 * Approve MCP calls in orchestrator background-agent children according to
 * the fixed config file. Allowlist mode is the default; allow-all is an
 * explicit opt-in. The file is read on every call (mtime-cached), so edits
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
			if (!shouldAutoApproveMcpTool(
				request as ApprovalRequest,
				readMcpApprovalConfig(allowlistFile),
			)) {
				return;
			}
			request.claim(async () => "allow_once");
		},
	);
	return true;
}
