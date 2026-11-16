/**
 * Attention signals sent through the terminal itself, so they work in whatever hosts the TUI.
 *
 *  - Bell (BEL): the universal one. tmux flags the window in its status line, cmux and most
 *    terminals mark the tab or bounce the dock icon.
 *  - OSC 777 (`ESC ] 777 ; notify ; TITLE ; BODY BEL`): a notification with text, understood by
 *    cmux, Ghostty, WezTerm, foot and others; terminals that do not know it ignore it.
 *
 * The terminal decides what to show, so a focused pane stays quiet on its own.
 */

export interface NotifyOptions {
	/** Send the OSC 777 text notification. */
	osc: boolean;
	/** Ring the terminal bell. */
	bell: boolean;
}

/** Notification fields travel inside an escape sequence: no control characters, no field separator. */
function field(text: string, max: number): string {
	const flat = text
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/;/g, ",")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Bytes to write to the terminal to signal that a session needs the user. */
export function notificationSequence(
	title: string,
	body: string,
	options: NotifyOptions = { osc: true, bell: true },
	env: NodeJS.ProcessEnv = process.env,
): string {
	let out = "";
	if (options.osc) {
		const osc = `\x1b]777;notify;${field(title, 80)};${field(body, 200)}\x07`;
		// tmux drops unknown OSC sequences unless they are wrapped for passthrough
		// (which also needs `set -g allow-passthrough on`).
		out += env.TMUX ? `\x1bPtmux;${osc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : osc;
	}
	if (options.bell) out += "\x07";
	return out;
}

/** Terminal focus reporting (DECSET 1004, enabled by the alt-screen renderer): CSI I / CSI O on focus changes. */
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

export interface AttentionState {
	busy: boolean;
	requestIds: string[];
	turnStatus: string | null;
}

export type Attention = { kind: "request"; requestId: string } | { kind: "finished"; failed: boolean };

/** What changed between two observations of a session that deserves the user's attention. */
export function attentionChange(prev: AttentionState | undefined, next: AttentionState): Attention | null {
	if (!prev) return null;
	const fresh = next.requestIds.find((id) => !prev.requestIds.includes(id));
	if (fresh) return { kind: "request", requestId: fresh };
	if (prev.busy && !next.busy && next.requestIds.length === 0) {
		return { kind: "finished", failed: next.turnStatus === "failed" };
	}
	return null;
}
