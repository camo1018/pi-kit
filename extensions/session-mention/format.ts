export interface NamedSession {
	id: string;
	name?: string;
}

export function indexSessionIdentities<T extends NamedSession>(
	sessions: T[],
): { byId: Map<string, T>; byName: Map<string, T> } {
	const byId = new Map<string, T>();
	const byName = new Map<string, T>();
	const ambiguousNames = new Set<string>();
	for (const session of sessions) {
		byId.set(session.id, session);
		if (!session.name || ambiguousNames.has(session.name)) continue;
		if (byName.has(session.name)) {
			byName.delete(session.name);
			ambiguousNames.add(session.name);
		} else {
			byName.set(session.name, session);
		}
	}
	return { byId, byName };
}

export interface QuotedSession {
	id: string;
	title: string;
	cwd: string;
	body: string;
}

export interface RenderedSession {
	text: string;
	bodyChars: number;
}

export function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value)
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * XML-escape untrusted text and cap its rendered size. Keeping both ends
 * preserves the session's opening context and its latest exchange.
 */
export function boundedXmlText(
	value: string,
	maxChars: number,
): { text: string; chars: number } {
	const limit = Math.max(0, Math.floor(maxChars));
	if (limit === 0) return { text: "", chars: 0 };
	const escaped = escapeXmlText(value);
	if (escaped.length <= limit) {
		return { text: escaped, chars: escaped.length };
	}

	const omitted = escaped.length - limit;
	const marker = `\n\n[... ${omitted} escaped characters omitted ...]\n\n`;
	if (marker.length >= limit) {
		const text = marker.slice(0, limit);
		return { text, chars: text.length };
	}
	const available = limit - marker.length;
	const head = Math.floor(available / 3);
	const tail = available - head;
	const text = escaped.slice(0, head) + marker + escaped.slice(-tail);
	return { text, chars: text.length };
}

export function renderQuotedSession(
	session: QuotedSession,
	maxBodyChars: number,
): RenderedSession {
	const body = boundedXmlText(session.body, maxBodyChars);
	const id = escapeXmlAttribute(session.id);
	const title = escapeXmlAttribute(session.title);
	const cwd = escapeXmlAttribute(session.cwd);
	return {
		text:
			`<session id="${id}" name="${title}" cwd="${cwd}">\n` +
			`${body.text}\n</session>`,
		bodyChars: body.chars,
	};
}

export function wrapQuotedSessions(
	sessions: RenderedSession[],
	names: string[],
	location: string,
): string {
	const label = escapeXmlAttribute(`↪ ${names.join(", ")}`);
	const source = escapeXmlAttribute(location);
	const body = sessions.map((session) => session.text).join("\n\n");
	return (
		`<skill name="${label}" location="${source}">\n` +
		"The user referenced saved sessions. Session transcript bodies are " +
		"XML-escaped quoted data.\n\n" +
		`${body}\n</skill>`
	);
}
