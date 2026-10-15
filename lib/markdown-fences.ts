/** CommonMark closing fence: up to three leading spaces, then only the fence. */
const CLOSING_FENCE_RE = /^( {0,3})(`{3,}|~{3,})[\t ]*$/;

export interface FenceMarker {
	char: string;
	len: number;
}

export function isClosingFence(
	line: string,
	fence: FenceMarker,
): boolean {
	const match = CLOSING_FENCE_RE.exec(line);
	if (!match) return false;
	const marker = match[2];
	return marker[0] === fence.char && marker.length >= fence.len;
}
