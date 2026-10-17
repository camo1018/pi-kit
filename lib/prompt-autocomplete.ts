import type {
	AutocompleteProviderFactory, ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

type UI = Pick<ExtensionUIContext, "addAutocompleteProvider">;
interface Capture {
	provider?: AutocompleteProvider;
	factory: AutocompleteProviderFactory;
}
const captures = new WeakMap<UI, Capture>();

/** Capture the normal prompt's complete provider via the public UI hook. */
export function promptAutocomplete(ui: UI): AutocompleteProvider | undefined {
	let capture = captures.get(ui);
	if (!capture) {
		const record: Capture = {
			factory(current) {
				record.provider = current;
				return current;
			},
		};
		captures.set(ui, record);
		capture = record;
	}
	// Append an identity hook when editing begins, AFTER other extensions'
	// wrappers (including $skill completion). No provider object is wrapped
	// or replaced. Reopening also picks up providers registered later.
	ui.addAutocompleteProvider(capture.factory);
	return capture.provider;
}
