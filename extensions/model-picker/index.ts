/**
 * model-picker — digits and arrows in the model selector.
 *
 * pi's built-in model selector (ctrl+l / /model) sends every digit to its
 * fuzzy search box, so there is no way to pick the Nth model with `1`..`9`.
 * This ports the inbox group selector's interaction to models:
 *
 *   ↑ ↓ / ← → / PgUp PgDn   navigate (left/right = page)
 *   1–9                     select the row with that number
 *   shift+tab               cycle the reasoning effort (wraps around)
 *   ctrl+n                  toggle digits between select and search text
 *   enter                   choose
 *   esc / ctrl+c            cancel
 *   tab                     toggle all / scoped (same as built-in)
 *
 * The effort is part of the same choice: pi re-derives the thinking level from
 * settings whenever a model changes, so picking a model and an effort together
 * here is the only way to mean both.
 *
 * Digits-as-select is the default because the intended use is a handful of
 * models from `enabledModels`; ctrl+n restores typing digits into the filter
 * for the larger `all` scope or to search for something like "4.1".
 *
 * Why this patches the editor instead of calling registerShortcut:
 * `app.model.select` is in pi's RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS,
 * so registerShortcut("ctrl+l", …) is dropped with a conflict diagnostic and
 * never dispatches. The documented workaround (same one tool-output-hide
 * uses) is to wrap CustomEditor.prototype.handleInput for editors that
 * interactive mode wired up, i.e. those carrying the built-in
 * `app.model.select` action handler, and divert that one key. Everything
 * else falls through to the original implementation, and `/model` still
 * opens the stock selector as an escape hatch.
 */

import { registerLoadedExtension } from "../../lib/loaded-extensions.ts";
import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { openModelPicker } from "./picker.ts";

const STATE_KEY = Symbol.for("pi.ext.model-picker");
const g = globalThis as unknown as Record<symbol, { open?: () => void; patched?: boolean } | undefined>;
const state = (g[STATE_KEY] ??= {});

/** Reached only while the user is in TUI mode; guards against print/json runs. */
function settingsFor(ctx: ExtensionContext) {
	return SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	});
}

function installPatch(): void {
	if (state.patched) return;
	state.patched = true;

	type EditorLike = {
		keybindings?: { matches(data: string, action: string): boolean };
		actionHandlers?: Map<string, unknown>;
		handleInput(data: string): void;
	};
	const proto = CustomEditor.prototype as unknown as EditorLike;
	const original = proto.handleInput;
	proto.handleInput = function (this: EditorLike, data: string): void {
		// Only the editors interactive mode wires up carry the built-in
		// app.model.select handler; pickers that reuse ctrl+l are untouched.
		if (
			typeof state.open === "function" &&
			this.actionHandlers?.has("app.model.select") &&
			this.keybindings?.matches(data, "app.model.select")
		) {
			state.open();
			return;
		}
		original.call(this, data);
	};
}

async function openPicker(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const picked = await openModelPicker(ctx, {
		// setModel lives on the extension API, not on ctx.
		commit: async (model, effort) => {
			if (!(await pi.setModel(model))) return false;
			// setModel re-derives the level from settings, so apply the level
			// chosen in the same dialog after it, not before.
			pi.setThinkingLevel(effort);
			return true;
		},
		// ctrl+s saves the startup defaults, like the stock selectors do.
		onPersist: (model, effort) => {
			const settings = settingsFor(ctx);
			settings.setDefaultModelAndProvider(model.provider, model.id);
			settings.setDefaultThinkingLevel(effort);
		},
	});
	if (picked) {
		ctx.ui.notify(
			`Model: ${picked.provider}/${picked.id} · effort ${pi.getThinkingLevel()}`,
			"info",
		);
	}
}

export default function (pi: ExtensionAPI) {
	registerLoadedExtension("model-picker");
	installPatch();

	let ctx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, c) => {
		if (c.mode !== "tui") return;
		ctx = c;
		state.open = () => {
			if (ctx) void openPicker(pi, ctx);
		};
	});

	pi.on("session_shutdown", async () => {
		ctx = undefined;
		state.open = undefined;
	});

	pi.registerCommand("models", {
		description: "Pick a model with digits, arrows and search (ctrl+l)",
		handler: async (_args, c) => openPicker(pi, c),
	});
}
