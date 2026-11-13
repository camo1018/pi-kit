/**
 * model-picker — digits and arrows in the model selector.
 *
 * pi's built-in model selector (ctrl+l / /model) sends every digit to its
 * fuzzy search box, so there is no way to pick the Nth model with `1`..`9`.
 * This ports the inbox group selector's interaction to models:
 *
 *   ↑ ↓ / ← → / PgUp PgDn   navigate (left/right = page)
 *   1–9                     select the row with that number
 *   ctrl+n                  toggle digits between select and search text
 *   enter                   choose
 *   esc / ctrl+c            cancel
 *   tab                     toggle all / scoped (same as built-in)
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
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { ModelPicker, type Entry } from "./picker.ts";

const STATE_KEY = Symbol.for("pi.ext.model-picker");
const g = globalThis as unknown as Record<symbol, { open?: () => void; patched?: boolean } | undefined>;
const state = (g[STATE_KEY] ??= {});

/** Reached only while the user is in TUI mode; guards against print/json runs. */
function modelsFor(ctx: ExtensionContext): { scoped: Entry[]; all: Entry[] } {
	const toEntry = (model: Model<any>): Entry => ({
		model,
		provider: model.provider,
		id: model.id,
		name: model.name,
	});
	const sort = (list: Entry[], current: Model<any> | undefined): Entry[] =>
		list.slice().sort((a, b) => {
			const aCur = current?.provider === a.provider && current?.id === a.id;
			const bCur = current?.provider === b.provider && current?.id === b.id;
			if (aCur !== bCur) return aCur ? -1 : 1;
			const byProvider = a.provider.localeCompare(b.provider);
			return byProvider !== 0 ? byProvider : a.id.localeCompare(b.id);
		});
	const scoped = sort(
		ctx.scopedModels.map((s) => toEntry(s.model)),
		ctx.model,
	);
	const all = sort(
		ctx.modelRegistry.getAvailable().map(toEntry),
		ctx.model,
	);
	return { scoped, all };
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
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("The model picker needs the interactive UI.", "warning");
		return;
	}
	const { scoped, all } = modelsFor(ctx);
	const picked = await ctx.ui.custom<Model<any> | undefined>(
		(tui, theme, keybindings, done) =>
			new ModelPicker(
				tui,
				theme,
				keybindings,
				done,
				scoped,
				all,
				ctx.model,
				// setModel lives on the extension API, not on ctx.
				(model) => pi.setModel(model),
			),
		{ overlay: true },
	);
	if (picked) {
		ctx.ui.notify(`Model: ${picked.provider}/${picked.id}`, "info");
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
