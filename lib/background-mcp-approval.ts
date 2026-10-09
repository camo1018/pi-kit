import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_MCP_AUTO_APPROVE_ENV =
	"PI_INBOX_AUTO_APPROVE_MCP";

const MCP_APPROVAL_EVENT =
	"pi-mcp-adapter:tool-approval-request";
const STATE_KEY = Symbol.for("pi.inbox.backgroundMcpApproval");

type ApprovalRequest = {
	claim(handler: () => Promise<"allow_once">): boolean;
};

type ApprovalState = {
	enabled: boolean;
	unsubscribe?: () => void;
};

function state(): ApprovalState {
	const globals = globalThis as any;
	return globals[STATE_KEY] ??=
		{ enabled: false } satisfies ApprovalState;
}

/**
 * Auto-approve MCP calls only in orchestrator background-agent children.
 *
 * The one-shot environment flag is removed after startup so tools and nested
 * Pi processes cannot inherit the approval policy. Process-global state keeps
 * the policy if Pi reloads the extension during the same child process.
 */
export function installBackgroundMcpAutoApproval(
	pi: Pick<ExtensionAPI, "events">,
	env: Record<string, string | undefined> = process.env,
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
			if (typeof request?.claim !== "function") return;
			request.claim(async () => "allow_once");
		},
	);
	return true;
}
