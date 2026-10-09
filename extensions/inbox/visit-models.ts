import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import {
	getAgentDir,
	ModelSelectorComponent,
	SettingsManager,
	ThinkingSelectorComponent,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import {
	nextSessionModel,
	parseAgentModel,
	setAgentModel,
} from "../../lib/inbox-agents.ts";
import { visiting } from "../../lib/visit-runtime.ts";

type Action = "select" | "forward" | "backward" | "thinking" | "cycleThinking";

/** Intercept model controls before Pi can mutate the hidden foreground runtime. */
export function handleVisitModelInput(
	data: string,
	ctx: ExtensionContext,
	tui: TUI,
	blockedReason: () => string | undefined,
): boolean {
	const visit = visiting();
	if (!visit) return false;
	const kb = getKeybindings();
	let action: Action | undefined;
	let search: string | undefined;
	if (kb.matches(data, "app.model.select")) action = "select";
	else if (kb.matches(data, "app.model.cycleForward")) action = "forward";
	else if (kb.matches(data, "app.model.cycleBackward")) action = "backward";
	else if (kb.matches(data, "app.thinking.cycle")) action = "cycleThinking";
	else if (
		kb.matches(data, "tui.input.submit") ||
		kb.matches(data, "app.message.followUp")
	) {
		const command = ctx.ui
			.getEditorText()
			.trim()
			.match(/^\/(model|thinking)(?:\s+(.*))?$/s);
		if (!command) return false;
		action = command[1] === "model" ? "select" : "thinking";
		search = command[2]?.trim() || undefined;
		ctx.ui.setEditorText("");
	}
	if (!action) return false;
	void changeModel(action, search).catch((error) => {
		ctx.ui.notify(`Model selection failed: ${String(error)}`, "error");
	});
	return true;

	async function changeModel(action: Action, search?: string) {
		if (!visit) return;
		const blocked = blockedReason();
		if (blocked) return ctx.ui.notify(blocked, "warning");
		const registry = ctx.modelRegistry;
		const current = parseAgentModel(
			visit.selectedModel ?? nextSessionModel(visit.id, visit.file),
		);
		const model = current && registry.find(current.provider, current.id);
		// A visited project does not inherit the hidden main's trust decision.
		const settings = SettingsManager.create(visit.cwd, getAgentDir(), {
			projectTrusted: visit.cwd === ctx.cwd && ctx.isProjectTrusted(),
		});
		const currentLevel = current?.thinkingLevel ?? "medium";

		function apply(
			next: Model<Api>,
			level?: ThinkingLevel,
			persistDefault = false,
		) {
			// A selector may outlive navigation; never apply to a different view.
			if (!visit || visiting() !== visit) return false;
			const blocked = blockedReason();
			if (blocked) {
				ctx.ui.notify(blocked, "warning");
				return false;
			}
			const thinking = clampThinkingLevel(
				next,
				level ??
					settings.getModelThinkingLevel(next.provider, next.id) ??
					settings.getDefaultThinkingLevel() ??
					currentLevel,
			);
			const reference = `${next.provider}/${next.id}:${thinking}`;
			setAgentModel(visit.id, visit.file, reference);
			visit.selectedModel = reference;
			if (persistDefault) {
				settings.setDefaultModelAndProvider(next.provider, next.id);
			}
			tui.requestRender();
			return true;
		}

		if (action === "thinking" || action === "cycleThinking") {
			if (!model) {
				return ctx.ui.notify("Select a model for this session first.", "info");
			}
			const levels = getSupportedThinkingLevels(model);
			if (action === "cycleThinking") {
				return apply(
					model,
					levels[(levels.indexOf(currentLevel) + 1) % levels.length],
				);
			}
			if (search) {
				const level = levels.find((level) => level === search.toLowerCase());
				if (level) return apply(model, level);
				return ctx.ui.notify(
					`Available thinking levels: ${levels.join(", ")}`,
					"warning",
				);
			}
			const selected = await ctx.ui.custom<
				| {
						level: ThinkingLevel;
						persist: boolean;
				  }
				| undefined
			>(
				(_tui, _theme, _kb, done) =>
					new ThinkingSelectorComponent(
						currentLevel,
						levels,
						(level) => done({ level, persist: false }),
						() => done(undefined),
						(level) => done({ level, persist: true }),
						settings.getDefaultThinkingLevel() ?? "medium",
					),
			);
			if (selected && apply(model, selected.level) && selected.persist) {
				settings.setDefaultThinkingLevel(selected.level);
			}
			return;
		}

		const available = registry.getAvailable();
		const scoped = ctx.scopedModels.filter(({ model }) =>
			available.some(
				(m) => m.provider === model.provider && m.id === model.id,
			),
		);
		const choices = ctx.scopedModels.length
			? scoped.map(({ model }) => model)
			: available;
		if (action === "forward" || action === "backward") {
			if (choices.length <= 1) return;
			const index = choices.findIndex(
				(m) => m.provider === current?.provider && m.id === current.id,
			);
			const step = action === "forward" ? 1 : -1;
			const next =
				choices[(Math.max(0, index) + step + choices.length) % choices.length];
			const scopedLevel = scoped.find((s) => s.model === next)?.thinkingLevel;
			return apply(next, scopedLevel);
		}
		if (search) {
			const matches = choices.filter(
				(m) =>
					m.id.toLowerCase() === search!.toLowerCase() ||
					`${m.provider}/${m.id}`.toLowerCase() === search!.toLowerCase(),
			);
			if (matches.length === 1) return apply(matches[0]);
		}
		// Use Pi's normal picker with a read-only registry facade, not the main's
		// ModelRuntime. Only its selection callback writes the visited choice.
		const runtime = {
			getAvailableSnapshot: () => registry.getAvailable(),
			getModel: (provider: string, id: string) => registry.find(provider, id),
			getError: () => registry.getError(),
			refresh: (options: Parameters<typeof registry.refresh>[0]) =>
				registry.refresh(options),
		} as unknown as ConstructorParameters<typeof ModelSelectorComponent>[2];
		const selected = await ctx.ui.custom<
			| {
					model: Model<Api>;
					persist: boolean;
			  }
			| undefined
		>(
			(tui, _theme, _kb, done) =>
				new ModelSelectorComponent(
					tui,
					model,
					runtime,
					ctx.scopedModels,
					(model) => done({ model, persist: false }),
					() => done(undefined),
					search,
					(model) => done({ model, persist: true }),
					settings.getDefaultProvider() && settings.getDefaultModel()
						? {
								provider: settings.getDefaultProvider()!,
								id: settings.getDefaultModel()!,
							}
						: undefined,
				),
		);
		if (selected) apply(selected.model, undefined, selected.persist);
	}
}
