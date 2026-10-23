import type {
	ReadonlySessionManager,
} from "@earendil-works/pi-coding-agent";

export type BranchKind = "Clone" | "Fork";

/** Names are session-wide, not rewound to the selected historical branch. */
export function branchName(name: string, kind: BranchKind): string {
	const base = name.replace(/(?: - (?:Clone|Fork))+$/, "").trim();
	return `${base.slice(0, 192)} - ${kind}`;
}

export function sourceName(sm: ReadonlySessionManager): string {
	const named = sm.getSessionName()?.trim();
	if (named) return named;
	for (const entry of sm.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: content.filter((b) => b.type === "text")
				.map((b) => b.text).join(" ");
		if (text.trim()) return text.replace(/\s+/g, " ").trim();
	}
	return "Session";
}

/** Compare against the local snapshot, not a newer background writer's tip. */
export function selectedHistory(sm: ReadonlySessionManager): boolean {
	const leaf = sm.getLeafEntry();
	return sm.getLeafId() !== sm.getEntries().at(-1)?.id ||
		(leaf?.type === "custom" &&
			leaf.customType === "pi-kit.tree-position");
}

/** Never include any of the active run, even its completed tool steps. */
export function beforeRun(
	sm: ReadonlySessionManager,
	run: { runBaseLeafId?: string | null; runStartedAt?: number },
): string | null | undefined {
	const branch = sm.getBranch();
	if (run.runBaseLeafId !== undefined) {
		const base = run.runBaseLeafId;
		return base === null || branch.some((e) => e.id === base)
			? base : undefined;
	}
	// Older/adopted agents lack a captured checkpoint. Use the FIRST user
	// prompt since launch (not the latest: steering belongs to the same run).
	const prompts = branch.filter((e) =>
		e.type === "message" && e.message.role === "user");
	const prompt = run.runStartedAt === undefined
		? prompts.at(-1)
		: prompts.find((e) => Date.parse(e.timestamp) >= run.runStartedAt!);
	// If the child hasn't persisted its prompt yet, all disk entries predate it.
	return prompt ? prompt.parentId : sm.getLeafId();
}
