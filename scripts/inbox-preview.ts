import * as path from "node:path";
import {
	getAgentDir, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/** Abort during extension loading, before an inbox supervisor can start. */
export default function (pi: ExtensionAPI) {
	const expected = process.env.PI_INBOX_PREVIEW_DIR;
	const actual = getAgentDir();
	if (!expected || path.resolve(actual) !== path.resolve(expected)) {
		process.stderr.write(
			"Preview refused to start: temporary agent directory not honored.\n" +
			`Expected: ${expected ?? "unset"}\nActual: ${actual}\n`,
		);
		process.exit(78);
	}
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setTitle("Pi inbox PREVIEW — temporary data");
		ctx.ui.setStatus("inbox-preview", "PREVIEW · temporary data");
	});
	pi.registerCommand("preview-info", {
		description: "Show the preview's isolated data directory",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`INBOX PREVIEW\nData: ${actual}\n` +
				"Only synthetic/test sessions are loaded.",
				"info",
			);
		},
	});
}
