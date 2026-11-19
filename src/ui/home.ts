import { type Component, type Focusable, fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isBusy, type Session, sessionTitle } from "../happier/client.js";
import { LOGO_HEIGHT, LOGO_WIDTH, renderLogo } from "./logo.js";
import { ago, c, clean, shortPath, SPINNER } from "./theme.js";

/** The list takes this share of a wide terminal, and the whole width of a narrow one. */
const WIDTH_SHARE = 0.7;
const MIN_WIDTH = 76;

/** Sessions that need the user come first, then live ones, then most recently used. */
export function sortSessions(sessions: Session[]): Session[] {
	const rank = (s: Session) =>
		s.pendingPermissionRequestCount + s.pendingUserActionRequestCount > 0 ? 0 : s.active ? 1 : 2;
	return [...sessions].sort((a, b) => rank(a) - rank(b) || b.activityAt - a.activityAt);
}

/** What a session is doing: a glyph, and a word when it is worth a look. */
function sessionStatus(s: Session, unread: boolean, frame: number): { glyph: string; word: string } {
	if (s.pendingPermissionRequestCount + s.pendingUserActionRequestCount > 0) {
		return { glyph: c.err("!"), word: c.err("needs you") };
	}
	if (isBusy(s)) return { glyph: c.warn(SPINNER[frame % SPINNER.length] ?? "*"), word: c.warn("working") };
	if (unread) return { glyph: c.accent("●"), word: c.accent("new reply") };
	return { glyph: s.active ? c.ok("●") : c.faint("○"), word: "" };
}

export const statusGlyph = (s: Session, frame: number): string => sessionStatus(s, false, frame).glyph;

/** The end of a path when it does not fit: the folder names are what tell sessions apart. */
const tail = (text: string, width: number): string =>
	visibleWidth(text) <= width ? text : `…${text.slice(text.length - (width - 1))}`;

const titleOf = (s: Session): string => clean(sessionTitle(s)).replace(/\s+/g, " ");
const pathOf = (s: Session): string => shortPath(s.metadata.path, s.metadata.homeDir);
const OPEN = " ◂ open";

/** Column widths of the session rows. */
interface Columns {
	title: number;
	agent: number;
	path: number;
}
/** The right column: the status word, else how long ago the session was active. */
const STATE_WIDTH = 9;

export interface HomeHost {
	name: string;
	online: boolean;
}

export interface HomeState {
	/** Sessions to offer, already sorted; inactive ones included only when `showInactive`. */
	sessions: Session[];
	/** Inactive sessions currently left out. */
	hidden: number;
	showInactive: boolean;
	/** Known machines, so hosts without a session are still listed. */
	hosts: HomeHost[];
	hostOf: (s: Session) => string;
	unread: Set<string>;
	currentId: string | null;
	frame: number;
	rows: number;
	/** The relay and the connection, then what is live: one line each. */
	status: string[];
}

type Entry =
	| { kind: "host"; name: string; online: boolean | null; count: number }
	| { kind: "session"; session: Session }
	| { kind: "action"; key: "new" | "inactive"; label: string; hint: string }
	| { kind: "note"; text: string }
	| { kind: "blank" };

/**
 * Start screen and session switcher: logo, a search box, and the sessions grouped by host.
 * Selection is tracked by key so it stays on the same session while the list updates live.
 */
export class Home implements Component, Focusable {
	onOpen?: (sessionId: string) => void;
	onNew?: () => void;
	onToggleInactive?: () => void;
	/** ctrl+x on a session: stop or archive it. */
	onManage?: (sessionId: string) => void;
	/** Escape with nothing to clear: return to the open session, if any. */
	onBack?: () => void;

	private readonly input = new Input({
		prompt: c.accent("⌕ "),
		placeholder: " search sessions, hosts, paths", // the space keeps the cursor off the text
		placeholderStyle: (text) => c.faint(text),
	});
	private selectedKey: string | null = null;
	private _focused = false;
	readonly capturesViewportInput = true;

	constructor(private readonly state: () => HomeState) {}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	/** Clears the search and puts the selection back on the open session (or the first one). */
	reset(): void {
		this.input.setValue("");
		this.selectedKey = null;
	}

	private entries(st: HomeState): Entry[] {
		const query = this.input.getValue().trim();
		const sessions = query
			? fuzzyFilter(
					st.sessions,
					query,
					(s) => `${sessionTitle(s)} ${st.hostOf(s)} ${s.metadata.flavor ?? ""} ${s.metadata.path ?? ""}`,
				)
			: st.sessions;

		const groups = new Map<string, Session[]>();
		for (const s of sessions) {
			const host = st.hostOf(s);
			const group = groups.get(host);
			if (group) group.push(s);
			else groups.set(host, [s]);
		}
		const online = new Map(st.hosts.map((h) => [h.name, h.online]));
		const out: Entry[] = [];
		for (const [name, group] of groups) {
			out.push({ kind: "host", name, online: online.get(name) ?? null, count: group.length });
			for (const session of group) out.push({ kind: "session", session });
			out.push({ kind: "blank" });
		}
		if (!query) {
			for (const h of st.hosts) {
				if (groups.has(h.name) || !h.online) continue;
				out.push({ kind: "host", name: h.name, online: true, count: 0 });
				out.push({ kind: "note", text: st.showInactive ? "no session" : "no active session" });
				out.push({ kind: "blank" });
			}
		}
		if (sessions.length === 0) {
			out.push({ kind: "note", text: query ? `No session matches "${query}".` : "No active session." });
			out.push({ kind: "blank" });
		}
		out.push({ kind: "action", key: "new", label: "+ New session", hint: "ctrl+n" });
		if (st.showInactive) {
			out.push({ kind: "action", key: "inactive", label: "− Hide inactive sessions", hint: "tab" });
		} else if (st.hidden > 0) {
			const label = `… Show ${st.hidden} inactive session${st.hidden === 1 ? "" : "s"}`;
			out.push({ kind: "action", key: "inactive", label, hint: "tab" });
		}
		return out;
	}

	private static keyOf(e: Entry): string | null {
		return e.kind === "session" ? e.session.id : e.kind === "action" ? `\0${e.key}` : null;
	}

	/**
	 * Index of the selected entry. Until the user moves the selection it follows the list: the
	 * open session if there is one, else the first row — so sessions that load after the screen
	 * appeared are selected ahead of the "new session" action.
	 */
	private selectedIndex(entries: Entry[]): number {
		const keys = entries.map(Home.keyOf);
		const index = this.selectedKey === null ? -1 : keys.indexOf(this.selectedKey);
		if (index >= 0) return index;
		const open = this.state().currentId;
		const preferred = open ? keys.indexOf(open) : -1;
		return preferred >= 0 ? preferred : keys.findIndex((k) => k !== null);
	}

	private move(entries: Entry[], delta: number): void {
		const selectable = entries.map((e, i) => (Home.keyOf(e) === null ? -1 : i)).filter((i) => i >= 0);
		if (selectable.length === 0) return;
		const at = selectable.indexOf(this.selectedIndex(entries));
		const next = selectable[Math.min(selectable.length - 1, Math.max(0, at + delta))];
		const entry = next === undefined ? undefined : entries[next];
		if (entry) this.selectedKey = Home.keyOf(entry);
	}

	handleInput(data: string): void {
		const st = this.state();
		const entries = this.entries(st);
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) return this.move(entries, -1);
		if (matchesKey(data, Key.down)) return this.move(entries, 1);
		if (matchesKey(data, "pageUp")) return this.move(entries, -6);
		if (matchesKey(data, "pageDown")) return this.move(entries, 6);
		if (matchesKey(data, Key.tab)) {
			this.onToggleInactive?.();
			return;
		}
		if (matchesKey(data, Key.ctrl("x"))) {
			const entry = entries[this.selectedIndex(entries)];
			if (entry?.kind === "session") this.onManage?.(entry.session.id);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const entry = entries[this.selectedIndex(entries)];
			if (entry?.kind === "session") this.onOpen?.(entry.session.id);
			else if (entry?.kind === "action" && entry.key === "new") this.onNew?.();
			else if (entry?.kind === "action") this.onToggleInactive?.();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.input.getValue()) {
				this.input.setValue("");
				this.selectedKey = null;
			} else this.onBack?.();
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		// A new query starts from its best match rather than a row that may have disappeared.
		if (this.input.getValue() !== before) this.selectedKey = null;
	}

	render(width: number): string[] {
		const st = this.state();
		// Columns sized to the sessions (all of them, so a search does not reshape the list), and the
		// block to its columns: as wide as they need, up to a share of a wide terminal.
		const agent = Math.min(8, Math.max(1, ...st.sessions.map((s) => String(s.metadata.flavor ?? "?").length)));
		const titleNeed = Math.min(60, Math.max(12, ...st.sessions.map((s) => visibleWidth(titleOf(s)) + (s.id === st.currentId ? OPEN.length : 0))));
		const pathNeed = Math.min(50, Math.max(8, ...st.sessions.map((s) => visibleWidth(pathOf(s)))));
		// "› ● ", then title, agent, path and state with two spaces between them.
		const fixed = 4 + 2 + agent + 2 + 2 + STATE_WIDTH;
		const fit = Math.min(fixed + titleNeed + pathNeed, Math.floor(width * WIDTH_SHARE));
		const block = Math.max(20, Math.min(width - 2, Math.max(MIN_WIDTH, fit)));
		const pad = " ".repeat(Math.max(1, Math.floor((width - block) / 2)));
		const spare = block - fixed;
		const title = Math.min(titleNeed, Math.max(12, Math.floor(spare * 0.55)));
		const cols: Columns = { title, agent, path: spare - title >= 8 ? spare - title : 0 };
		const entries = this.entries(st);
		const selected = this.selectedIndex(entries);

		const name = c.accent.bold("happier-tui");
		const tagline = c.faint("your Happier agents, from the terminal");
		const head: string[] = [];
		if (st.rows >= 24 && block >= LOGO_WIDTH + 44) {
			// The bunny on the left; name, then status, in a column beside it.
			const beside = [name, tagline, "", ...st.status];
			const top = Math.max(0, Math.floor((LOGO_HEIGHT - beside.length) / 2));
			head.push("");
			renderLogo().forEach((line, row) => head.push(`${line}    ${beside[row - top] ?? ""}`));
			head.push("");
		} else {
			head.push("", `${name}  ${st.status.join(c.faint("  ·  "))}`, "");
		}
		head.push(...this.input.render(block), "");

		const body: string[] = [];
		let selectedLine = 0;
		entries.forEach((entry, i) => {
			if (i === selected) selectedLine = body.length;
			body.push(this.renderEntry(entry, i === selected, st, block, cols));
		});

		const keys = "↑↓ select · enter open · type to search · ctrl+n new · ctrl+x stop/archive · tab inactive · esc back · ctrl+c quit";
		const foot = ["", ...wrapTextWithAnsi(keys, block).map((l) => c.faint(l))];

		// Keep the selection on screen when the list is taller than the terminal.
		const room = Math.max(3, st.rows - head.length - foot.length);
		let from = 0;
		if (body.length > room) from = Math.min(body.length - room, Math.max(0, selectedLine - Math.floor(room / 2)));
		const shown = body.slice(from, from + room);
		if (from > 0) shown[0] = c.faint("  ↑ more");
		if (from + room < body.length) shown[shown.length - 1] = c.faint("  ↓ more");

		// A short list sits a little above the middle of the screen rather than at the top.
		const lines = [...head, ...shown, ...foot];
		const above = Array<string>(Math.max(0, Math.floor((st.rows - lines.length) * 0.4))).fill("");
		return [...above, ...lines].map((line) => truncateToWidth(`${pad}${line}`, width));
	}

	private renderEntry(entry: Entry, selected: boolean, st: HomeState, width: number, cols: Columns): string {
		switch (entry.kind) {
			case "blank":
				return "";
			case "note":
				return c.faint(`    ${entry.text}`);
			case "host": {
				const dot = entry.online === null ? "" : entry.online ? c.ok(" ● online") : c.faint(" ○ offline");
				const count = entry.count > 0 ? c.faint(`  ${entry.count} session${entry.count === 1 ? "" : "s"}`) : "";
				return `${c.bold(entry.name)}${dot}${count}`;
			}
			case "action": {
				const text = `${selected ? c.accent("› ") : "  "}${selected ? c.accent.bold(entry.label) : entry.label}  ${c.faint(entry.hint)}`;
				return selected ? c.selBg(truncateToWidth(text, width, "…", true)) : text;
			}
			case "session": {
				const s = entry.session;
				const unread = st.unread.has(s.id);
				const status = sessionStatus(s, unread, st.frame);
				const open = s.id === st.currentId ? OPEN : "";
				const title = truncateToWidth(titleOf(s), cols.title - open.length, "…", true);
				const name = selected ? c.accent.bold(title) : unread ? c.bold(title) : s.active ? title : c.dim(title);
				const agent = c.faint(truncateToWidth(String(s.metadata.flavor ?? "?"), cols.agent, "…", true));
				const path = cols.path
					? `${c.faint(truncateToWidth(tail(pathOf(s), cols.path), cols.path, "", true))}  `
					: "";
				const state = status.word || c.faint(ago(s.activityAt));
				const right = " ".repeat(Math.max(0, STATE_WIDTH - visibleWidth(state))) + state;
				const text = `${selected ? c.accent("› ") : "  "}${status.glyph} ${name}${c.accent(open)}  ${agent}  ${path}${right}`;
				const fitted = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
				return selected ? c.selBg(truncateToWidth(fitted, width, "", true)) : fitted;
			}
		}
	}
}
