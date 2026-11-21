import { appendFileSync } from "node:fs";
import {
	type Component,
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	type OverlayHandle,
	ProcessTerminal,
	ScrollView,
	type SlashCommand,
	truncateToWidth,
	TuiAltScreen,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type HappierClient,
	HappierError,
	isBusy,
	type MessageRow,
	type PermissionRequest,
	pendingRequests,
	type QueuedPrompt,
	type Session,
	sessionModels,
	sessionTitle,
} from "./happier/client.js";
import { CLAUDE_EFFORT_LEVELS, effortOverride, isWaitingForLimit, sessionGoal, sessionModes, sessionOptions, usageLimit } from "./happier/controls.js";
import { latestOptions, type Row, Transcript } from "./happier/transcript.js";
import {
	type Attention,
	type AttentionState,
	attentionChange,
	FOCUS_IN,
	FOCUS_OUT,
	type NotifyOptions,
	notificationSequence,
} from "./ui/notify.js";
import { type LocalLaunch, NewSessionFlow } from "./new-session.js";
import { errorText, justify, machineName, questionsOf, requestSummary, shortHost, untilText } from "./ui/format.js";
import { cmuxBind, cmuxUnbind } from "./cmux.js";
import { SessionAutocomplete } from "./ui/autocomplete.js";
import { PromptEditor } from "./ui/prompt-editor.js";
import { Picker, type PickerOptions } from "./ui/picker.js";
import { Home, sortSessions, statusGlyph } from "./ui/home.js";
import { agoText, c, clean, editorTheme, shortPath, SPINNER } from "./ui/theme.js";
import { TranscriptView } from "./ui/transcript-view.js";

const PERMISSION_MODES = ["default", "read-only", "safe-yolo", "yolo", "plan"];
/** Without input for this long the user counts as away, even if the terminal still has focus. */
const PRESENCE_IDLE_MS = 3 * 60_000;

const LOCAL_COMMANDS: SlashCommand[] = [
	{ name: "sessions", description: "Back to the session list (ctrl+s)" },
	{ name: "new-session", description: "Start a new agent session on a machine (ctrl+n)" },
	{ name: "mode", description: "Change the agent mode or the permission mode" },
	{ name: "model", description: "Change the model" },
	{ name: "effort", description: "Change the thinking level (reasoning effort)" },
	{ name: "rename", description: "Rename this session" },
	{ name: "queue", description: "Edit or cancel messages waiting to be sent" },
	{ name: "tree", description: "Branch into a new session from an earlier message" },
	{ name: "goal", description: "Show, set or clear the session's goal" },
	{ name: "limit", description: "After a usage limit: resume automatically, check now" },
	{ name: "abort", description: "Interrupt the current turn (esc)" },
	{ name: "stop-session", description: "Stop the session's agent process" },
	{ name: "archive", description: "Archive this session" },
	{ name: "reload", description: "Reload sessions and this transcript" },
	{ name: "keys", description: "Show key bindings" },
	{ name: "quit", description: "Exit" },
];

/** Sent to the agent like its own commands; Happier runs them for every agent, listed or not. */
const RUNNER_COMMANDS: SlashCommand[] = [
	{ name: "compact", description: "Summarize the conversation so far to free up context" },
];

const KEYS_HELP = [
	"enter send · shift+enter newline · esc interrupt the agent",
	"ctrl+s session list · ctrl+n new session · alt+↑/↓ previous/next active session",
	"ctrl+r answer a permission request · ctrl+o expand tool output · ctrl+t toggle thinking",
	"pgup/pgdn scroll · ctrl+shift+f search · ctrl+c twice to quit",
].join("\n");

/** Appends a line to $HAPPIER_TUI_DEBUG, for diagnosing focus / notification decisions. */
function debug(message: string): void {
	const file = process.env.HAPPIER_TUI_DEBUG;
	if (!file) return;
	try {
		appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// diagnostics must never break the UI
	}
}

class Lines implements Component {
	constructor(private readonly fn: (width: number) => string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		return this.fn(width).map((l) => truncateToWidth(l, width));
	}
}

interface Entry {
	transcript: Transcript;
	loaded: boolean;
	hasEarlier: boolean;
	nextBeforeSeq: number | null;
	loadingEarlier: boolean;
}

export class App {
	private readonly tui: TuiAltScreen;
	private readonly view = new TranscriptView();
	private readonly scroll: ScrollView;
	private readonly editor: PromptEditor;
	private readonly home: Home;
	private readonly chatRoot: VStack;
	private readonly homeRoot: VStack;
	/** "home" is the start screen / session switcher, "chat" an open session. */
	private mode: "home" | "chat" = "home";
	private readonly entries = new Map<string, Entry>();
	private readonly unread = new Set<string>();
	/** Sessions we sent a prompt to and have not heard back from yet. */
	private readonly awaiting = new Map<string, number>();
	private readonly prompted = new Set<string>();
	/** Last observed attention-relevant state per session, to notify on changes only. */
	private readonly attention = new Map<string, AttentionState>();
	/** Other sessions that signalled and still wait for the user, shown in the footer (latest last). */
	private readonly rang = new Map<string, Attention>();
	/** Whether this terminal has focus. Only meaningful once `focusKnown` is set. */
	private focused = true;
	/** The terminal has reported focus at least once, i.e. it supports focus reporting. */
	private focusKnown = false;
	private lastInputAt = Date.now();
	private readonly newSessionFlow: NewSessionFlow;
	private currentId: string | null = null;
	private showInactive = false;
	private loaded = false;
	private loadError = "";
	private frame = 0;
	private notice: { text: string; level: "info" | "warn" | "error"; until: number } | null = null;
	private overlay: OverlayHandle | null = null;
	private lastCtrlC = 0;
	private everConnected = false;
	private connection: "connecting" | "connected" | "disconnected" = "connecting";
	private timer: NodeJS.Timeout | null = null;
	private commandsKey = "";
	private readonly files = new Map<string, { at: number; list: Promise<string[]> }>();
	/** Prompts waiting in each session's pending queue, as last fetched. */
	private readonly queued = new Map<string, QueuedPrompt[]>();
	/** The session's pending count when its queue was last fetched. */
	private readonly queuedCount = new Map<string, number>();
	/** A queued prompt being edited in the editor; enter saves it back to the queue. */
	private editingQueued: { sessionId: string; localId: string } | null = null;
	/** Transcript version last seen at the bottom, to tell about output arriving while scrolled up. */
	private seen: { id: string | null; version: number } = { id: null, version: 0 };
	private resolveDone: () => void = () => {};
	readonly done = new Promise<void>((r) => {
		this.resolveDone = r;
	});

	constructor(
		private readonly client: HappierClient,
		private readonly initialSession?: string,
		private readonly notify: NotifyOptions = { osc: true, bell: true },
		/** Start a session on this computer right away instead of showing the start screen. */
		private readonly launch?: LocalLaunch,
	) {
		// The alt-screen renderer enables terminal focus reporting and consumes the focus events in
		// its own input listener, which runs before ours. Observe them at the terminal instead.
		const terminal = new ProcessTerminal();
		const start = terminal.start.bind(terminal);
		terminal.start = (onInput, onResize) =>
			start((data) => {
				if (data === FOCUS_IN || data === FOCUS_OUT) this.onTerminalFocus(data === FOCUS_IN);
				onInput(data);
			}, onResize);
		this.tui = new TuiAltScreen(terminal, false, undefined, {
			scrollToEndIndicator: () => c.accent(" ↓ jump to latest "),
		});
		this.scroll = new ScrollView(this.view, { follow: "end", primary: true, scrollbar: "auto" });
		this.editor = new PromptEditor(this.tui, editorTheme, { paddingX: 2 });
		this.editor.onSubmit = (text) => void this.submit(text);
		this.home = new Home(() => {
			const machines = [...this.client.machines.values()];
			const active = this.sortedSessions().filter((x) => x.active).length;
			const online = machines.filter((m) => m.active).length;
			const link = this.connection === "connected" ? c.ok("● connected") : this.connection === "connecting" ? c.warn("◌ connecting") : c.err("○ offline — retrying");
			return {
				sessions: this.visibleSessions(),
				hidden: this.hiddenCount(),
				showInactive: this.showInactive,
				hosts: machines.map((m) => ({ name: machineName(m), online: m.active })),
				hostOf: (x) => this.hostOf(x),
				unread: this.unread,
				currentId: this.currentId,
				frame: this.frame,
				rows: this.tui.terminal.rows - this.renderRequests(this.tui.terminal.columns).length,
				status: this.loaded
					? [
							`${this.client.config.serverName}  ${link}`,
							c.dim(`${active} active session${active === 1 ? "" : "s"} · ${online} machine${online === 1 ? "" : "s"} online`),
						]
					: [c.dim(this.loadError || `Connecting to ${this.client.config.serverName}…`)],
			};
		});
		this.home.onOpen = (id) => void this.openSession(id);
		this.home.onNew = () => this.run(() => this.newSession());
		this.home.onManage = (id) => {
			const s = this.client.sessions.get(id);
			if (s) this.run(() => this.manageSession(s));
		};
		this.home.onToggleInactive = () => {
			this.showInactive = !this.showInactive;
			this.tui.requestRender();
		};
		this.home.onBack = () => {
			if (this.currentId) void this.openSession(this.currentId);
		};

		this.chatRoot = new VStack([
			{ component: new Lines((w) => this.renderHeader(w)), basis: 2, shrink: 0 },
			{ component: this.scroll, basis: 0, grow: 1, minSize: 3 },
			{ component: new Lines((w) => this.renderRequests(w)), basis: "auto", shrink: 0 },
			{ component: this.editor, basis: "auto", shrink: 1, minSize: 3 },
			{ component: new Lines((w) => this.renderFooter(w)), basis: 1, shrink: 0 },
		]);
		this.homeRoot = new VStack([
			{ component: this.home, basis: 0, grow: 1, minSize: 3 },
			{ component: new Lines((w) => this.renderRequests(w)), basis: "auto", shrink: 0 },
		]);
		this.showHome();
		this.view.isBusy = () => {
			const s = this.current();
			return !!s && this.busy(s);
		};
		// Keep the clicked line where it is while what is below it unfolds.
		this.view.onToggle = () => this.scroll.scrollTo(this.scroll.scrollTop, { disableFollow: true });
		this.view.onOption = (option) => void this.submit(option);
		this.view.onSubagent = (callId) => {
			const s = this.current();
			if (s) void this.loadSubagent(s, callId);
		};
		this.newSessionFlow = new NewSessionFlow({
			client: this.client,
			pick: (opts) => this.pick(opts),
			flash: (text, level, ms) => this.flash(text, level, ms),
			clearNotice: () => {
				this.notice = null;
			},
		});
		this.tui.addInputListener((data) => (this.onKey(data) ? { consume: true } : undefined));
	}

	// --- lifecycle ---

	async start(): Promise<void> {
		this.tui.start();
		this.wireClient();
		this.timer = setInterval(() => this.tick(), 120);

		try {
			await Promise.all([this.client.refreshSessions(), this.client.refreshMachines().catch(() => [])]);
			this.loaded = true;
		} catch (e) {
			this.loadError = `Could not load sessions: ${errorText(e)}`;
			this.tui.requestRender();
			this.client.connect();
			return;
		}
		this.client.connect();
		for (const s of this.client.sessions.values()) this.attention.set(s.id, attentionOf(s));

		// A session named on the command line opens directly; otherwise the start screen stays up.
		const wanted = this.initialSession;
		if (wanted) {
			const requested = this.sortedSessions().find((s) => s.id === wanted || s.id.startsWith(wanted) || s.metadata.tag === wanted);
			if (requested) await this.openSession(requested.id);
			else this.flash(`No session matches "${wanted}"`, "warn");
		} else if (this.launch) {
			const launch = this.launch;
			this.run(() => this.newSession(launch));
		}
		this.tui.requestRender();
	}

	/** Shows the start screen, which doubles as the session switcher. */
	private showHome(): void {
		this.mode = "home";
		this.home.reset();
		this.tui.setLayoutRoot(this.homeRoot);
		this.tui.setFocus(this.home);
		this.tui.requestRender();
	}

	private quit(): void {
		if (this.timer) clearInterval(this.timer);
		this.client.close();
		cmuxUnbind();
		// The alt-screen renderer prints its document to the main screen on stop; leave nothing behind.
		this.tui.setLayoutRoot(new Lines(() => []));
		this.tui.stop();
		this.resolveDone();
	}

	private tick(): void {
		this.frame++;
		const now = Date.now();
		let dirty = false;
		if (this.notice && this.notice.until < now) {
			this.notice = null;
			dirty = true;
		}
		for (const [id, at] of this.awaiting) {
			if (now - at > 90_000) {
				this.awaiting.delete(id);
				dirty = true;
			}
		}
		this.syncPresence();
		const anyBusy = [...this.client.sessions.values()].some((s) => this.busy(s));
		if (anyBusy) dirty = true;
		// The start screen shows each session's age.
		if (this.mode === "home" && !this.overlay) dirty = true;
		this.maybeLoadEarlier();
		if (dirty) this.tui.requestRender();
	}

	// --- client events ---

	private wireClient(): void {
		const cl = this.client;
		cl.on("connection", (state, detail) => {
			this.connection = state;
			if (state === "connected") {
				if (this.everConnected) void this.resync();
				this.everConnected = true;
			} else if (state === "disconnected" && detail && /token|auth/i.test(detail)) {
				this.flash(`Relay rejected the connection: ${detail}`, "error", 15_000);
			}
			this.tui.requestRender();
		});
		cl.on("session", (s) => {
			this.noteAttention(s);
			if (s.id === this.currentId) {
				if (isBusy(s)) this.awaiting.delete(s.id);
				if (s.pendingCount !== (this.queuedCount.get(s.id) ?? 0)) void this.refreshQueue(s);
				this.refreshCommands(s);
				this.promptForRequests(s);
			}
			this.tui.requestRender();
		});
		cl.on("session-removed", (id) => {
			this.attention.delete(id);
			this.rang.delete(id);
			this.entries.delete(id);
			this.unread.delete(id);
			if (id === this.currentId) {
				this.currentId = null;
				this.view.setTranscript(null);
				this.showHome();
			}
			this.tui.requestRender();
		});
		cl.on("message", (sid, row) => {
			const entry = this.entries.get(sid);
			const isAgent = isRecordRole(row, "agent");
			if (isAgent) this.awaiting.delete(sid);
			if (entry?.loaded) entry.transcript.upsert(row, row.record);
			if (sid !== this.currentId) {
				if (isAgent) this.unread.add(sid);
			} else {
				// The turn's last message may land after the session reported the turn over.
				const s = this.current();
				if (s) this.promptForRequests(s);
			}
			this.tui.requestRender();
		});
		cl.on("stream-segment", (sid, row) => {
			const entry = this.entries.get(sid);
			this.awaiting.delete(sid);
			if (entry?.loaded && entry.transcript.upsert(row, row.record) && sid === this.currentId) {
				this.tui.requestRender();
			}
		});
		cl.on("stream-delta", (sid, localId, text, base) => {
			const entry = this.entries.get(sid);
			if (entry?.loaded && entry.transcript.appendDelta(localId, text, base) && sid === this.currentId) {
				this.tui.requestRender();
			}
		});
		cl.on("machine", () => this.tui.requestRender());
	}

	/** After a reconnect: updates may have been missed, so re-read what is on screen. */
	private async resync(): Promise<void> {
		try {
			await this.client.refreshSessions();
			for (const id of [...this.entries.keys()]) if (id !== this.currentId) this.entries.delete(id);
			const s = this.current();
			const entry = s && this.entries.get(s.id);
			if (s && entry?.loaded) await this.catchUp(s, entry);
		} catch (e) {
			this.flash(`Resync failed: ${errorText(e)}`, "warn");
		}
		this.tui.requestRender();
	}

	private async catchUp(s: Session, entry: Entry): Promise<void> {
		let after = entry.transcript.maxSeq ?? 0;
		for (let i = 0; i < 20; i++) {
			const page = await this.client.fetchMessages(s, { afterSeq: after, limit: 500 });
			for (const m of page.messages) entry.transcript.upsert(m, m.record);
			if (!page.hasMore || page.nextAfterSeq === null || page.nextAfterSeq <= after) break;
			after = page.nextAfterSeq;
		}
	}

	// --- sessions ---

	private current(): Session | undefined {
		return this.currentId ? this.client.sessions.get(this.currentId) : undefined;
	}

	/**
	 * Sessions listed by default: live ones, plus any that need an answer and the one on screen.
	 * Inactive sessions are shown on the start screen on demand (tab).
	 */
	private visibleSessions(): Session[] {
		const all = this.sortedSessions();
		if (this.showInactive) return all;
		return all.filter(
			(s) => s.active || s.id === this.currentId || s.pendingPermissionRequestCount + s.pendingUserActionRequestCount > 0,
		);
	}

	private hiddenCount(): number {
		return this.sortedSessions().length - this.visibleSessions().length;
	}

	private sortedSessions(): Session[] {
		return sortSessions([...this.client.sessions.values()].filter((s) => !s.archivedAt));
	}

	private hostOf(s: Session): string {
		const m = typeof s.metadata.machineId === "string" ? this.client.machines.get(s.metadata.machineId) : undefined;
		return machineName(m) || shortHost(s.metadata.host) || "?";
	}

	private busy(s: Session): boolean {
		return isBusy(s) || this.awaiting.has(s.id);
	}

	async openSession(id: string): Promise<void> {
		const s = this.client.sessions.get(id);
		if (!s) return;
		this.currentId = id;
		cmuxBind(id);
		this.rang.delete(id);
		this.unread.delete(id);
		if (this.mode !== "chat") {
			this.mode = "chat";
			this.tui.setLayoutRoot(this.chatRoot);
		}
		this.tui.setFocus(this.editor);
		let entry = this.entries.get(id);
		if (!entry) {
			entry = { transcript: new Transcript(), loaded: false, hasEarlier: false, nextBeforeSeq: null, loadingEarlier: false };
			this.entries.set(id, entry);
		}
		this.view.setTranscript(entry.transcript);
		this.view.hasEarlier = entry.hasEarlier;
		this.view.loadingEarlier = false;
		this.view.placeholder = entry.loaded ? "No messages yet. Type a prompt to start." : "Loading transcript…";
		this.refreshCommands(s);
		this.scroll.scrollToEnd();
		this.tui.requestRender();

		if (!entry.loaded) {
			if (!s.key) {
				this.view.placeholder = "This session is end-to-end encrypted and no matching key is available on this device.";
			} else {
				try {
					const page = await this.client.fetchMessages(s);
					for (const m of page.messages) entry.transcript.upsert(m, m.record);
					entry.loaded = true;
					entry.hasEarlier = page.hasMore && page.nextBeforeSeq !== null;
					entry.nextBeforeSeq = page.nextBeforeSeq;
					if (page.messages.some((m) => m.record === null)) {
						this.flash("Some messages could not be decrypted and are hidden.", "warn");
					}
					this.view.placeholder = isDirect(s)
						? "This is a direct session: its transcript lives on the machine, not the relay, and is not shown here yet."
						: "No messages yet. Type a prompt to start.";
				} catch (e) {
					this.view.placeholder = `Could not load transcript: ${errorText(e)}`;
				}
			}
			if (this.currentId !== id) return;
			this.view.hasEarlier = entry.hasEarlier;
			this.scroll.scrollToEnd();
		}
		if (s.pendingCount > 0) void this.refreshQueue(s);
		this.promptForRequests(s);
		this.tui.requestRender();
	}

	private async refreshQueue(s: Session): Promise<QueuedPrompt[]> {
		this.queuedCount.set(s.id, s.pendingCount);
		const list = await this.client.listQueue(s).catch(() => this.queued.get(s.id) ?? []);
		this.queued.set(s.id, list);
		this.tui.requestRender();
		return list;
	}

	/** Loads a subagent's transcript the first time its tool call is shown. */
	private async loadSubagent(s: Session, callId: string): Promise<void> {
		const entry = this.entries.get(s.id);
		if (!entry) return;
		entry.transcript.sidechain(callId); // marks it as requested
		let before: number | undefined;
		for (let page = 0; page < 10; page++) {
			const res = await this.client.fetchMessages(s, { sidechainId: callId, beforeSeq: before, limit: 500 }).catch(() => null);
			if (!res) break;
			for (const m of res.messages) entry.transcript.upsert({ ...m, sidechainId: callId }, m.record);
			if (!res.hasMore || res.nextBeforeSeq === null) break;
			before = res.nextBeforeSeq;
		}
		this.tui.requestRender();
	}

	private maybeLoadEarlier(): void {
		const s = this.current();
		const entry = s && this.entries.get(s.id);
		if (!s || !entry?.loaded || !entry.hasEarlier || entry.loadingEarlier || entry.nextBeforeSeq === null) return;
		const height = this.view.render(this.view.lastWidth).length;
		const atTop = this.scroll.scrollTop === 0 && (!this.scroll.isFollowingEnd || height <= this.scroll.viewportHeight);
		if (!atTop || this.scroll.viewportHeight === 0) return;
		void this.loadEarlier(s, entry);
	}

	private async loadEarlier(s: Session, entry: Entry): Promise<void> {
		entry.loadingEarlier = true;
		this.view.loadingEarlier = true;
		this.tui.requestRender();
		try {
			const before = this.view.render(this.view.lastWidth).length;
			const page = await this.client.fetchMessages(s, { beforeSeq: entry.nextBeforeSeq ?? undefined });
			for (const m of page.messages) entry.transcript.upsert(m, m.record);
			entry.hasEarlier = page.hasMore && page.nextBeforeSeq !== null;
			entry.nextBeforeSeq = page.nextBeforeSeq;
			if (this.currentId === s.id) {
				this.view.hasEarlier = entry.hasEarlier;
				this.view.loadingEarlier = false;
				const added = this.view.render(this.view.lastWidth).length - before;
				if (!this.scroll.isFollowingEnd && added > 0) {
					this.scroll.scrollTo(this.scroll.scrollTop + added, { disableFollow: true });
				}
			}
		} catch (e) {
			entry.hasEarlier = false;
			this.view.hasEarlier = false;
			this.flash(`Could not load earlier messages: ${errorText(e)}`, "warn");
		} finally {
			entry.loadingEarlier = false;
			this.view.loadingEarlier = false;
			this.tui.requestRender();
		}
	}

	private refreshCommands(s: Session): void {
		const remote: SlashCommand[] = [];
		const details = Array.isArray(s.metadata.slashCommandDetails) ? s.metadata.slashCommandDetails : [];
		const names = Array.isArray(s.metadata.slashCommands) ? s.metadata.slashCommands : [];
		const seen = new Set(LOCAL_COMMANDS.map((x) => x.name));
		// Details are `{command, description}`; plain names cover agents that publish only those.
		for (const d of [...details, ...names, ...RUNNER_COMMANDS]) {
			const name = typeof d === "string" ? d : isObj(d) ? String(d.command ?? d.name ?? "") : "";
			const clean = name.replace(/^\//, "");
			if (!clean || seen.has(clean)) continue;
			seen.add(clean);
			const description = isObj(d) && typeof d.description === "string" ? d.description : "agent command";
			remote.push({ name: clean, description });
		}
		const key = `${s.id}:${remote.map((c) => c.name).join(" ")}`;
		if (key === this.commandsKey) return;
		this.commandsKey = key;
		void this.sessionFiles(s); // warm the `@` index; a large tree takes seconds to list
		this.editor.placeholder = `Message ${s.metadata.flavor ?? "the agent"} · @ files · / commands`;
		this.editor.setAutocompleteProvider(new SessionAutocomplete([...LOCAL_COMMANDS, ...remote], () => this.sessionFiles(s)));
	}

	/** The session's file list for `@` completion, fetched once per session and kept for a minute. */
	private sessionFiles(s: Session): Promise<string[]> {
		const cached = this.files.get(s.id);
		if (cached && Date.now() - cached.at < 60_000) return cached.list;
		const list = this.client.listFiles(s).catch((e) => {
			debug(`file list for ${s.id}: ${errorText(e)}`);
			return [] as string[];
		});
		this.files.set(s.id, { at: Date.now(), list });
		return list;
	}

	// --- input ---

	/** Global keys. Returns true when the key was handled and must not reach the focused component. */
	private onKey(data: string): boolean {
		// Terminals speaking the Kitty keyboard protocol report press, repeat and release as separate
		// events. Input listeners see all of them (the library only filters releases for the focused
		// component), so act on the press alone — otherwise every toggle fires twice and undoes itself.
		this.lastInputAt = Date.now();
		if (isKeyRelease(data) || isKeyRepeat(data)) return false;
		if (this.overlay) return false;
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.mode === "chat" && this.editor.getText()) {
				this.editor.setText("");
				return true;
			}
			const now = Date.now();
			if (now - this.lastCtrlC < 1500) this.quit();
			else {
				this.lastCtrlC = now;
				this.flash("Press ctrl+c again to quit", "info", 1500);
			}
			return true;
		}
		if (matchesKey(data, Key.ctrl("n"))) return this.run(() => this.newSession());
		// Everything else on the start screen belongs to its own list and search box.
		if (this.mode === "home") return false;
		if (matchesKey(data, Key.ctrl("d")) && !this.editor.getText()) {
			this.quit();
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			const s = this.current();
			if (this.editor.isShowingAutocomplete()) return false;
			if (this.editingQueued) {
				this.editingQueued = null;
				this.editor.setText("");
				this.flash("Stopped editing; the queued message is unchanged.", "info");
				return true;
			}
			if (!s || !this.busy(s)) return false;
			void this.abort();
			return true;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.showHome();
			return true;
		}
		if (matchesKey(data, Key.ctrl("r"))) return this.run(() => this.answerRequest());
		if (matchesKey(data, Key.ctrl("o"))) {
			this.relayout(() => {
				this.view.options.expandTools = !this.view.options.expandTools;
			});
			this.flash(this.view.options.expandTools ? "Tool output expanded" : "Tool output collapsed", "info", 1500);
			return true;
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			this.relayout(() => {
				this.view.options.showThinking = !this.view.options.showThinking;
			});
			this.flash(this.view.options.showThinking ? "Thinking shown" : "Thinking hidden", "info", 1500);
			return true;
		}
		if (matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("down"))) {
			const list = this.visibleSessions();
			const i = list.findIndex((s) => s.id === this.currentId);
			const next = list[(i + (matchesKey(data, Key.alt("up")) ? -1 : 1) + list.length) % list.length];
			if (next) void this.openSession(next.id);
			return true;
		}
		return false;
	}

	/**
	 * Applies a change that alters row heights while keeping the same message at the top of the
	 * viewport. When the view is following the end it simply stays at the end.
	 */
	private relayout(change: () => void): void {
		const following = this.scroll.isFollowingEnd;
		this.view.render(this.view.lastWidth);
		const anchor = following ? null : this.view.anchorAt(this.scroll.scrollTop);
		change();
		if (anchor) {
			const before = this.view.render(this.view.lastWidth).length;
			const start = this.view.lineOf(anchor.key);
			if (start !== null && before > 0) this.scroll.scrollTo(start + anchor.offset, { disableFollow: true });
		}
		this.tui.requestRender();
	}

	private run(fn: () => Promise<void>): boolean {
		fn().catch((e) => this.flash(errorText(e), "error", 8000));
		return true;
	}

	private async submit(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text) return;
		this.editor.addToHistory(text);
		const cmd = /^\/([\w-]+)\s*(.*)$/.exec(text);
		if (cmd && LOCAL_COMMANDS.some((x) => x.name === cmd[1])) {
			this.run(() => this.command(cmd[1]!, cmd[2] ?? ""));
			return;
		}
		const s = this.current();
		const entry = s && this.entries.get(s.id);
		const editing = this.editingQueued;
		if (s && editing?.sessionId === s.id) {
			this.editingQueued = null;
			try {
				await this.client.editQueued(s, editing.localId, text);
				this.flash("Queued message updated.", "info");
			} catch (e) {
				this.editor.setText(raw);
				this.flash(`Not updated: ${errorText(e)}`, "error", 8000);
			}
			void this.refreshQueue(s);
			return;
		}
		if (!s || !entry) {
			this.flash("No session open — ctrl+s for the session list.", "warn");
			this.editor.setText(raw);
			return;
		}
		try {
			const { localId, record } = await this.client.sendMessage(s, text);
			entry.transcript.upsert({ localId, createdAt: Date.now() }, record);
			this.awaiting.set(s.id, Date.now());
			this.scroll.scrollToEnd();
			if (!s.active) this.flash("Session is inactive — asked its machine to resume it.", "info", 6000);
		} catch (e) {
			this.editor.setText(raw);
			this.flash(`Send failed: ${errorText(e)}`, "error", 10_000);
		}
		this.tui.requestRender();
	}

	private async command(name: string, arg: string): Promise<void> {
		const s = this.current();
		switch (name) {
			case "sessions":
				this.showHome();
				return;
			case "new-session":
				return this.newSession();
			case "abort":
				return this.abort();
			case "keys":
				this.flash(KEYS_HELP, "info", 20_000);
				return;
			case "quit":
				this.quit();
				return;
			case "reload": {
				await Promise.all([this.client.refreshSessions(), this.client.refreshMachines()]);
				if (s) {
					this.entries.delete(s.id);
					await this.openSession(s.id);
				}
				this.flash("Reloaded.", "info");
				return;
			}
			case "mode":
				return s && this.chooseMode(s, arg);
			case "effort":
				return s && this.chooseEffort(s, arg);
			case "rename": {
				if (!s) return;
				if (!arg.trim()) {
					this.editor.setText(`/rename ${sessionTitle(s)}`);
					this.flash("Edit the title and press enter.", "info");
					return;
				}
				await this.client.rename(s, arg.trim());
				this.flash(`Renamed to "${arg.trim()}".`, "info");
				return;
			}
			case "queue":
				return s && this.manageQueue(s);
			case "tree":
				return s && this.branch(s);
			case "goal":
				return s && this.goal(s, arg.trim());
			case "limit":
				return s && this.limit(s);
			case "model": {
				if (!s) return;
				const { current, available: reported } = sessionModels(s);
				let available = reported;
				if (available.length === 0 && !arg) {
					// A fresh session has not reported its models yet; ask its machine instead.
					const machineId = s.metadata.machineId;
					const machine = typeof machineId === "string" ? await this.client.getMachine(machineId) : undefined;
					const agent = typeof s.metadata.flavor === "string" ? s.metadata.flavor : "";
					if (machine?.active && agent) {
						this.flash(`Asking ${machineName(machine)} for ${agent} models…`, "info", 60_000);
						const cwd = typeof s.metadata.path === "string" ? s.metadata.path : undefined;
						available = await this.client.probeModels(machine, agent, cwd).catch(() => []);
						this.notice = null;
					}
				}
				if (available.length === 0 && !arg) {
					this.flash("Could not get a model list for this session. Use /model <model-id> to set one by id.", "warn", 8000);
					return;
				}
				const match = arg && (available.find((m) => m.id === arg || m.name === arg)?.id ?? arg);
				const model =
					match ||
					(await this.pick({
						title: `Model (${available.length})`,
						selected: current,
						maxVisible: 14,
						items: available.map((m) => ({
							value: m.id,
							label: m.name,
							description: [m.description, m.id === current ? "current" : ""].filter(Boolean).join(" · "),
						})),
					}));
				if (!model || model === current) return;
				await this.client.setModel(s, model);
				this.flash(`Model: ${model} (applies from your next message)`, "info");
				return;
			}
			case "stop-session": {
				if (!s) return;
				if (await this.confirm(`Stop the agent process for "${sessionTitle(s)}"?`)) await this.endSession(s, "stop");
				return;
			}
			case "archive": {
				if (!s) return;
				if (await this.confirm(`Archive "${sessionTitle(s)}"?`)) await this.endSession(s, "archive");
				return;
			}
		}
	}

	/** ctrl+x in the session list: stop a session's agent, archive the session, or both. */
	private async manageSession(s: Session): Promise<void> {
		const how = await this.pick({
			title: `End "${oneLine(sessionTitle(s))}"`,
			noFilter: true,
			items: s.active
				? [
						{ value: "stop", label: "Stop the agent", description: "the session stays listed as inactive" },
						{ value: "stop-archive", label: "Stop and archive", description: "remove it from the list" },
					]
				: [{ value: "archive", label: "Archive", description: "remove it from the list" }],
		});
		if (how === "stop" || how === "stop-archive" || how === "archive") await this.endSession(s, how);
	}

	private async endSession(s: Session, how: "stop" | "stop-archive" | "archive"): Promise<void> {
		if (how !== "archive") {
			await this.client.stopSession(s);
			if (how === "stop") return this.flash("Stop requested.", "info");
			this.flash("Stopping…", "info");
			if (!(await this.client.waitStopped(s.id))) {
				throw new HappierError("The agent is still running; archive the session once it has stopped.");
			}
		}
		try {
			await this.client.archive(s);
		} catch (e) {
			if (e instanceof HappierError && e.code === "session-active") {
				throw new HappierError("Session is still running — stop it first (/stop-session, or ctrl+x in the session list).");
			}
			throw e;
		}
		this.flash("Archived.", "info");
	}

	private async abort(): Promise<void> {
		const s = this.current();
		if (!s) return;
		this.awaiting.delete(s.id);
		const ok = await this.client.abort(s);
		this.flash(ok ? "Interrupt sent." : "Nothing to interrupt (no agent attached).", ok ? "info" : "warn");
	}

	// --- session controls ---

	/** Agent modes (when the agent reports its own) and permission modes, in one list. */
	private async chooseMode(s: Session, arg: string): Promise<void> {
		const agent = sessionModes(s.metadata);
		const permission = typeof s.metadata.permissionMode === "string" ? s.metadata.permissionMode : "default";
		const items = [
			...agent.available.map((m) => ({
				value: `agent:${m.value}`,
				label: m.name,
				description: ["agent mode", m.value === agent.current ? "current" : "", m.description].filter(Boolean).join(" · "),
			})),
			...PERMISSION_MODES.map((m) => ({ value: `perm:${m}`, label: m, description: `permissions${m === permission ? " · current" : ""}` })),
		];
		const byArg = arg && items.find((i) => i.value.endsWith(`:${arg}`) || i.label === arg)?.value;
		const choice =
			byArg ||
			(await this.pick({
				title: "Mode",
				noFilter: items.length < 10,
				selected: agent.current ? `agent:${agent.current}` : `perm:${permission}`,
				items,
			}));
		if (!choice) return;
		const value = choice.slice(choice.indexOf(":") + 1);
		if (choice.startsWith("agent:")) await this.client.setMode(s, value);
		else await this.client.setPermissionMode(s, value);
		this.flash(`Mode: ${value} (applies from your next message)`, "info");
	}

	private async chooseEffort(s: Session, arg: string): Promise<void> {
		const model = sessionModels(s).current;
		const reported = sessionOptions(s.metadata, model).find((o) => o.id === "reasoning_effort");
		// Claude takes an effort even when the session did not publish the model's levels.
		const effort =
			reported ??
			(s.metadata.flavor === "claude"
				? { current: effortOverride(s.metadata) ?? "", choices: CLAUDE_EFFORT_LEVELS.map((l) => ({ value: l, name: l })) }
				: undefined);
		if (!effort) {
			this.flash(`${model || "This model"} does not report thinking levels.`, "warn");
			return;
		}
		const value =
			effort.choices.find((ch) => ch.value === arg || ch.name.toLowerCase() === arg.toLowerCase())?.value ??
			(await this.pick({
				title: `Thinking level · ${model}`,
				hint: reported ? undefined : "this session did not report its levels; the model may not take them all",
				noFilter: true,
				selected: effort.current,
				items: effort.choices.map((ch) => ({ value: ch.value, label: ch.name, description: ch.value === effort.current ? "current" : "" })),
			}));
		if (!value || value === effort.current) return;
		await this.client.setOption(s, "reasoning_effort", value);
		this.flash(`Thinking level: ${value} (applies from your next message)`, "info");
	}

	private async manageQueue(s: Session): Promise<void> {
		const queued = await this.refreshQueue(s);
		if (queued.length === 0) {
			this.flash("No message is waiting to be sent.", "info");
			return;
		}
		const id = await this.pick({
			title: `Waiting to be sent (${queued.length})`,
			items: queued.map((q) => ({
				value: q.localId,
				label: oneLine(q.text),
				description: q.delivering ? "being delivered" : agoText(q.createdAt),
			})),
		});
		const q = queued.find((x) => x.localId === id);
		if (!q) return;
		if (q.delivering) {
			this.flash("That message is already being handed to the agent; it can no longer be changed.", "info");
			return;
		}
		const action = await this.pick({
			title: oneLine(q.text),
			noFilter: true,
			items: [
				{ value: "edit", label: "Edit", description: "load it in the editor; enter saves, esc leaves it as is" },
				{ value: "cancel", label: "Cancel", description: "remove it from the queue" },
			],
		});
		if (action === "cancel") {
			await this.client.cancelQueued(s, q.localId);
			await this.refreshQueue(s);
			this.flash("Cancelled.", "info");
		} else if (action === "edit") {
			this.editingQueued = { sessionId: s.id, localId: q.localId };
			this.editor.setText(q.text);
			this.flash("Editing a queued message: enter saves it, esc leaves it unchanged.", "info", 10_000);
		}
	}

	/**
	 * Branches the conversation into a new session, like Pi's /tree: the new session holds what
	 * came before the chosen message, which is put back in the editor to rewrite. Codex sessions
	 * can instead be rolled back in place.
	 */
	private async branch(s: Session): Promise<void> {
		const prompts = (this.entries.get(s.id)?.transcript.list() ?? [])
			.filter((r): r is Row & { seq: number } => r.seq !== undefined && r.items[0]?.kind === "user")
			.reverse();
		const textOf = (r: Row) => (r.items[0]?.kind === "user" ? r.items[0].text : "");
		const choice = await this.pick({
			title: "Branch from",
			hint: "a new session continues from just before the message you pick (scroll up first to reach older ones)",
			maxVisible: 14,
			items: [
				{ value: "latest", label: "The whole conversation", description: "copy everything so far" },
				...prompts.map((r) => ({ value: String(r.seq), label: oneLine(textOf(r)), description: agoText(r.createdAt) })),
			],
		});
		if (!choice) return;
		const row = prompts.find((r) => String(r.seq) === choice);
		if (row && s.metadata.flavor === "codex" && s.active) {
			const how = await this.pick({
				title: oneLine(textOf(row)),
				noFilter: true,
				items: [
					{ value: "fork", label: "Branch into a new session", description: "this session stays as it is" },
					{ value: "rollback", label: "Roll back this session", description: "undo this message and everything after it" },
				],
			});
			if (!how) return;
			if (how === "rollback") {
				if (!(await this.confirm("Undo this message and everything after it in this session?"))) return;
				await this.client.rollback(s, row.seq);
				this.entries.delete(s.id);
				await this.openSession(s.id);
				this.editor.setText(textOf(row));
				this.flash("Rolled back; the message is back in the editor.", "info");
				return;
			}
		}
		this.flash("Creating the branch…", "info", 180_000);
		const childId = await this.client.fork(s, row ? row.seq : null);
		await this.client.waitForSession(childId);
		this.notice = null;
		await this.openSession(childId);
		if (row) this.editor.setText(textOf(row));
		this.flash(row ? "New branch; rewrite the message and press enter." : "New branch with the whole conversation.", "info", 8000);
	}

	private async goal(s: Session, arg: string): Promise<void> {
		if (arg === "clear") {
			await this.client.setGoal(s, null);
			this.flash("Goal cleared.", "info");
			return;
		}
		if (arg) {
			await this.client.setGoal(s, arg);
			this.flash("Goal set.", "info");
			return;
		}
		const goal = sessionGoal(s.metadata);
		if (!goal) {
			this.editor.setText("/goal ");
			this.flash("Type the goal after /goal and press enter (Claude and Codex sessions).", "info", 8000);
			return;
		}
		const action = await this.pick({
			title: `Goal · ${goal.status}: ${oneLine(goal.title)}`,
			noFilter: true,
			items: [
				{ value: "edit", label: "Change it" },
				{ value: "clear", label: "Clear it" },
			],
		});
		if (action === "edit") this.editor.setText(`/goal ${goal.title}`);
		else if (action === "clear") return this.goal(s, "clear");
	}

	private async limit(s: Session): Promise<void> {
		const u = usageLimit(s.metadata);
		const waiting = isWaitingForLimit(u);
		const action = await this.pick({
			title: waiting ? `Waiting for the usage limit${u?.resetAt ? ` to reset at ${untilText(u.resetAt)}` : ""}` : "Usage limit",
			noFilter: true,
			items: [
				...(waiting
					? [{ value: "waitResume.cancel", label: "Stop waiting", description: "do not resume this session by itself" }]
					: [{ value: "waitResume.enable", label: "Resume automatically", description: "continue this session when the limit resets" }]),
				{ value: "checkNow", label: "Check now", description: "resume right away if the limit has reset" },
			],
		});
		if (!action) return;
		const res = await this.client.usageLimitAction(s, action as "waitResume.enable" | "waitResume.cancel" | "checkNow");
		this.flash(`Usage limit: ${String(res.status ?? "done").replace(/_/g, " ")}`, "info");
	}

	// --- overlays ---

	private pick(opts: Omit<PickerOptions, "onSelect" | "onCancel">): Promise<string | null> {
		return new Promise((resolve) => {
			const close = (value: string | null) => {
				this.overlay?.hide();
				this.overlay = null;
				this.tui.setFocus(this.mode === "home" ? this.home : this.editor);
				this.tui.requestRender();
				resolve(value);
			};
			const picker = new Picker({ ...opts, onSelect: (item) => close(item.value), onCancel: () => close(null) });
			this.overlay?.hide();
			this.overlay = this.tui.showOverlay(picker, { width: "70%", minWidth: 44, maxHeight: "80%", anchor: "center" });
		});
	}

	private async confirm(question: string): Promise<boolean> {
		const v = await this.pick({
			title: question,
			noFilter: true,
			items: [
				{ value: "no", label: "No" },
				{ value: "yes", label: "Yes" },
			],
		});
		return v === "yes";
	}

	/**
	 * Opens the answer picker for what the open session waits on: each permission request once,
	 * and choices the agent offered once its turn ends, unless you have started typing.
	 */
	private promptForRequests(s: Session): void {
		if (this.overlay || this.mode !== "chat" || s.id !== this.currentId) return;
		const next = pendingRequests(s).find((r) => !this.prompted.has(`${s.id}:${r.id}`));
		if (next) {
			this.prompted.add(`${s.id}:${next.id}`);
			this.run(() => this.answer(s, next));
			return;
		}
		const offer = this.offeredOptions(s);
		// Keyed on the message that offers them, so a dismissed popup stays dismissed.
		const key = offer && `${s.id}:options:${offer.key}`;
		if (!offer || !key || this.prompted.has(key) || this.editor.getText().trim()) return;
		this.prompted.add(key);
		this.run(() => this.chooseOption(offer.options));
	}

	/** ctrl+r: answer what the agent is waiting for: a permission request, else its offered choices. */
	private async answerRequest(): Promise<void> {
		const s = this.current();
		const req = s && pendingRequests(s)[0];
		if (s && req) return this.answer(s, req);
		const offer = s && this.offeredOptions(s);
		if (!offer) {
			this.flash("Nothing to answer in this session.", "info");
			return;
		}
		await this.chooseOption(offer.options);
	}

	private async chooseOption(options: string[]): Promise<void> {
		const choice = await this.pick({
			title: "Reply with",
			noFilter: true,
			hint: `1–${options.length} or ↑↓ enter · esc to write your own reply (ctrl+r brings this back)`,
			items: options.map((o, i) => ({ value: o, label: `${i + 1}. ${oneLine(o)}` })),
		});
		if (choice) await this.submit(choice);
	}

	/** Choices the agent offered at the end of its last turn, while it waits for the reply. */
	private offeredOptions(s: Session): { key: string; options: string[] } | undefined {
		const entry = this.entries.get(s.id);
		return entry && !this.busy(s) ? latestOptions(entry.transcript) : undefined;
	}

	private async answer(s: Session, req: PermissionRequest): Promise<void> {
		const questions = questionsOf(req);
		if (questions.length > 0) {
			const answers: Record<string, string[]> = {};
			for (const q of questions) {
				const choice = await this.pick({
					title: q.question,
					noFilter: true,
					items: q.options,
					hint: "esc to answer later (ctrl+r)",
				});
				if (choice === null) return;
				answers[q.question] = [choice];
			}
			await this.client.respondQuestion(s, req, answers);
			return;
		}
		const detail = requestSummary(req);
		const choice = await this.pick({
			title: `Allow ${req.tool}?`,
			noFilter: true,
			hint: detail ? `${detail}   ·   esc to decide later (ctrl+r)` : "esc to decide later (ctrl+r)",
			items: [
				{ value: "approved", label: "Allow once" },
				{ value: "approved_for_session", label: `Always allow ${req.tool} in this session` },
				{ value: "denied", label: "Deny" },
				{ value: "abort", label: "Deny and stop the turn" },
			],
		});
		if (!choice) return;
		await this.client.respondPermission(s, req, choice as "approved" | "approved_for_session" | "denied" | "abort");
	}

	private async newSession(local?: LocalLaunch): Promise<void> {
		const sessionId = await this.newSessionFlow.run(local);
		if (sessionId) await this.openSession(sessionId);
	}

	// --- attention ---

	private onTerminalFocus(focused: boolean): void {
		this.focusKnown = true;
		this.focused = focused;
		if (focused) this.lastInputAt = Date.now();
		debug(`terminal focus ${focused ? "in" : "out"}`);
		// Leaving must lift the phone mute right away, not on the next tick.
		this.syncPresence();
	}

	/** The user is at this terminal: it has focus and they typed or scrolled recently. */
	private present(): boolean {
		return this.focused && Date.now() - this.lastInputAt < PRESENCE_IDLE_MS;
	}

	private readonly readUpTo = new Map<string, number>();

	/** Reports presence to the relay (phone-push muting) and advances the read cursor of the open session. */
	private syncPresence(): void {
		const present = this.present();
		this.client.setUiFocus(present);
		const s = this.current();
		if (!present || this.mode !== "chat" || !s || !this.entries.get(s.id)?.loaded) return;
		if (s.seq > (this.readUpTo.get(s.id) ?? 0)) {
			this.readUpTo.set(s.id, s.seq);
			this.client.markRead(s, s.seq);
		}
	}

	/** True when the user is looking at this session right now. */
	private watching(sessionId: string): boolean {
		// Without focus reporting we cannot tell whether the user is looking, so we never claim it:
		// the notification is emitted and the terminal decides whether a focused pane needs a banner.
		return this.focusKnown && this.present() && this.mode === "chat" && sessionId === this.currentId;
	}

	/**
	 * Only the open session rings, and only when the user is not already looking at it: with
	 * several happier-tui open, an event rings once, in the tab showing that session.
	 */
	private rings(sessionId: string): boolean {
		return (this.notify.osc || this.notify.bell) && sessionId === this.currentId && !this.watching(sessionId);
	}

	/**
	 * Raises a terminal notification when the open session starts needing the user (permission
	 * request, question) or finishes its turn, unless they are already looking at it. Other
	 * sessions are listed in the footer.
	 */
	private noteAttention(s: Session): void {
		const next = attentionOf(s);
		const prev = this.attention.get(s.id);
		const change = attentionChange(prev, next);
		this.attention.set(s.id, next);
		const rung = this.rang.get(s.id);
		if (rung && (rung.kind === "request" ? !next.requestIds.includes(rung.requestId) : next.busy)) this.rang.delete(s.id);
		if (change && s.id !== this.currentId) {
			this.rang.delete(s.id);
			this.rang.set(s.id, change);
		}
		if (prev && (prev.busy !== next.busy || prev.turnStatus !== next.turnStatus || prev.requestIds.length !== next.requestIds.length)) {
			debug(
				`session ${s.id.slice(0, 8)} busy ${prev.busy}->${next.busy} turn ${prev.turnStatus}->${next.turnStatus} requests ${prev.requestIds.length}->${next.requestIds.length} => ${change ? change.kind : "no change"}; focused=${this.focused} present=${this.present()} current=${s.id === this.currentId} notify=${Boolean(change && this.rings(s.id))}`,
			);
		}
		if (!change || !this.rings(s.id)) return;
		let body: string;
		if (change.kind === "request") {
			const req = pendingRequests(s).find((r) => r.id === change.requestId);
			const detail = req ? requestSummary(req) : "";
			body = req && questionsOf(req).length ? "Has a question for you" : `Needs permission: ${req?.tool ?? "tool"}${detail ? ` — ${detail}` : ""}`;
		} else {
			body = change.failed ? "Turn failed" : "Finished — waiting for you";
		}
		this.tui.terminal.write(notificationSequence(`${sessionTitle(s)} · ${this.hostOf(s)}`, body, this.notify));
	}

	// --- chrome ---

	private flash(text: string, level: "info" | "warn" | "error" = "info", ms = 4000): void {
		this.notice = { text, level, until: Date.now() + ms };
		this.tui.requestRender();
	}

	private renderHeader(width: number): string[] {
		const s = this.current();
		const conn =
			this.connection === "connected"
				? c.ok("● connected")
				: this.connection === "connecting"
					? c.warn("◌ connecting")
					: c.err("○ offline — retrying");
		let left = ` ${c.accent.bold("happier-tui")}`;
		if (s) {
			left += `  ${statusGlyph(s, this.frame)} ${c.bold.whiteBright(clean(sessionTitle(s)).replace(/\s+/g, " "))}`;
			left += c.faint(`  ${s.metadata.flavor ?? "?"} · ${this.hostOf(s)} · ${shortPath(s.metadata.path, s.metadata.homeDir)}`);
		} else {
			left += c.dim(`  ${this.client.config.serverName}`);
		}
		// A blank line keeps the conversation off the header when scrolled.
		return [c.headerBg(justify(left, `${conn} `, width)), ""];
	}

	private renderRequests(width: number): string[] {
		const lines: string[] = [];
		const s = this.current();
		const version = (s && this.entries.get(s.id)?.transcript.version) ?? 0;
		if (this.scroll.isFollowingEnd || s?.id !== this.seen.id) this.seen = { id: s?.id ?? null, version };
		else if (version > this.seen.version) lines.push(` ${c.accent("↓ new messages below")} ${c.faint("· pgdn to read")}`);
		if (s) {
			const goal = sessionGoal(s.metadata);
			if (goal && !["complete", "cancelled"].includes(goal.status)) {
				const status = goal.reason ? `${goal.status}, ${goal.reason}` : goal.status;
				lines.push(truncateToWidth(` ${c.accent("◎")} ${c.dim(`goal (${status}):`)} ${clean(oneLine(goal.title))}`, width));
			}
			const limit = usageLimit(s.metadata);
			if (limit) {
				const when = limit.resetAt ? ` at ${untilText(limit.resetAt)}` : "";
				const text = isWaitingForLimit(limit)
					? `Usage limit: resumes by itself${when}`
					: `Usage limit: ${limit.status}${when} · /limit`;
				lines.push(` ${c.warn("⏸")} ${c.warn(text)}`);
			}
			const queued = this.queued.get(s.id) ?? [];
			for (const q of queued.slice(0, 3)) {
				const label = q.delivering ? "⧗ sending:" : "⧗ queued:";
				lines.push(truncateToWidth(` ${c.dim(label)} ${clean(oneLine(q.text))}`, width));
			}
			if (queued.length > 0) {
				const more = queued.length > 3 ? `+${queued.length - 3} more · ` : "";
				lines.push(c.faint(`   ${more}/queue to edit or cancel`));
			}
			const reqs = pendingRequests(s);
			const offered = reqs.length === 0 ? (this.offeredOptions(s)?.options.length ?? 0) : 0;
			if (offered > 0) lines.push(` ${c.accent("❯")} ${c.dim(`${offered} choices above · click one, or ctrl+r`)}`);
			const first = reqs[0];
			if (first) {
				const more = reqs.length > 1 ? c.dim(` (+${reqs.length - 1} more)`) : "";
				const what = questionsOf(first).length ? "Question from the agent" : `Permission: ${first.tool} ${c.dim(requestSummary(first))}`;
				lines.push(` ${c.warn("⚠")} ${what}${more}`);
				lines.push(c.dim("   ctrl+r to answer"));
			}
		}
		if (this.notice) {
			const color = this.notice.level === "error" ? c.err : this.notice.level === "warn" ? c.warn : c.accent;
			for (const part of this.notice.text.split("\n")) {
				for (const l of wrapTextWithAnsi(part, Math.max(10, width - 2))) lines.push(` ${color(l)}`);
			}
		}
		return lines;
	}

	private renderFooter(width: number): string[] {
		const s = this.current();
		if (!s) return [justify(c.dim(" ctrl+s sessions · ctrl+n new session"), c.dim("/keys "), width)];
		const parts: string[] = [];
		const mode = typeof s.metadata.permissionMode === "string" ? s.metadata.permissionMode : "default";
		parts.push(mode === "yolo" || mode === "bypassPermissions" ? c.err(mode) : c.dim(mode));
		const model = sessionModels(s).current;
		if (model) parts.push(c.dim(model));
		const effort =
			sessionOptions(s.metadata, model).find((o) => o.id === "reasoning_effort")?.current ?? effortOverride(s.metadata);
		if (effort) parts.push(c.dim(`thinking ${effort}`));
		const usage = this.entries.get(s.id)?.transcript.usage;
		if (usage?.contextUsed && usage.contextWindow) {
			const pct = Math.round((usage.contextUsed / usage.contextWindow) * 100);
			const of = `${tokens(usage.contextUsed)}/${tokens(usage.contextWindow)}`;
			parts.push((pct >= 85 ? c.warn : c.dim)(`context ${pct}% (${of})`));
		} else if (usage?.contextUsed) parts.push(c.dim(`context ${tokens(usage.contextUsed)}`));
		if (usage?.cost) parts.push(c.dim(`$${usage.cost.toFixed(2)}`));
		let state: string;
		if (this.busy(s)) state = c.warn(`${SPINNER[this.frame % SPINNER.length]} working`) + c.dim(" · esc to interrupt");
		else if (!s.active) state = c.dim("inactive · sending resumes it");
		else state = c.ok("ready");
		const right = `${this.busy(s) ? "" : `last activity ${agoText(s.activityAt)} · `}ctrl+s sessions · /keys `;
		return [justify(` ${state}${c.dim("  ·  ")}${parts.join(c.dim(" · "))}`, c.faint(right), width)];
	}
}

// --- helpers -----------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** 126443 → "126k", 1000000 → "1M". */
function tokens(n: number): string {
	if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

function isDirect(s: Session): boolean {
	return isObj(s.metadata.directSessionV1) && s.seq === 0;
}

function isRecordRole(row: MessageRow, role: string): boolean {
	return isObj(row.record) && row.record.role === role;
}

function attentionOf(s: Session): AttentionState {
	return { busy: isBusy(s), requestIds: pendingRequests(s).map((r) => r.id), turnStatus: s.latestTurnStatus };
}
