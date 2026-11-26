/**
 * User-scoped Happier relay client: HTTP for reads/actions, Socket.IO for realtime.
 * Wire details follow upstream docs/protocol.md, docs/api.md and the CLI's
 * `happier session ...` implementation (apps/cli/src/session/**).
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { io, type Socket } from "socket.io-client";
import type { AccountKeys, HappierConfig } from "./config.js";
import { effortOverride, usageLimit, withConfigOverride, withModeOverride } from "./controls.js";
import {
	b64decode,
	b64encode,
	type ContentKey,
	decryptBytes,
	encryptBytes,
	machineKeyFromLegacySecret,
	openAccountScoped,
	openDataKeyEnvelope,
} from "./crypto.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export interface PermissionRequest {
	id: string;
	tool: string;
	kind?: string;
	arguments: unknown;
	createdAt?: number;
	occurrenceId?: string;
}

export interface Session {
	id: string;
	seq: number;
	createdAt: number;
	updatedAt: number;
	/**
	 * Last time something meaningful happened (a message, a turn starting or ending). Unlike
	 * `updatedAt` it is not moved by keep-alives or metadata housekeeping, so it is what lists
	 * sort and date by.
	 */
	activityAt: number;
	active: boolean;
	activeAt: number;
	archivedAt: number | null;
	encryptionMode: "e2ee" | "plain";
	/** null when this client holds no key able to read the session. */
	key: ContentKey | null;
	metadata: Obj;
	metadataVersion: number;
	agentState: Obj | null;
	agentStateVersion: number;
	thinking: boolean;
	latestTurnStatus: string | null;
	pendingCount: number;
	pendingPermissionRequestCount: number;
	pendingUserActionRequestCount: number;
}

export interface Machine {
	id: string;
	active: boolean;
	activeAt: number;
	key: ContentKey | null;
	metadata: Obj;
	daemonState: Obj | null;
}

export interface MessageRow {
	id?: string;
	seq?: number;
	localId: string | null;
	createdAt: number;
	/** Set on a subagent's messages: the id of the tool call that started it. */
	sidechainId: string | null;
	/** Decrypted record, or null when it could not be decrypted. */
	record: unknown;
}

/** A prompt waiting in the session's pending queue. */
export interface QueuedPrompt {
	localId: string;
	text: string;
	createdAt: number;
	/** Being handed to the agent: it can no longer be edited or cancelled. */
	delivering: boolean;
}

export interface MessagePage {
	messages: MessageRow[];
	hasMore: boolean;
	nextBeforeSeq: number | null;
	nextAfterSeq: number | null;
}

export type SpawnResult =
	| { type: "success"; sessionId?: string }
	| { type: "requestToApproveDirectoryCreation"; directory: string }
	| { type: "error"; errorMessage: string };

export class HappierError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly status?: number,
	) {
		super(message);
	}
}

export interface ClientEvents {
	connection: [state: "connecting" | "connected" | "disconnected", detail?: string];
	/** A session row was added or changed. */
	session: [session: Session];
	"session-removed": [id: string];
	/** A durable transcript row (new or updated). */
	message: [sessionId: string, row: MessageRow];
	/** Live stream segment snapshot (not durable yet). */
	"stream-segment": [sessionId: string, row: MessageRow];
	/** Live stream segment delta: appended text for `localId`. */
	"stream-delta": [sessionId: string, localId: string, text: string, baseLength: number];
	machine: [machine: Machine];
}

// --- helpers -----------------------------------------------------------------

function sessionTitleFallback(path: unknown): string {
	return typeof path === "string" ? (path.split(/[\\/]/).filter(Boolean).pop() ?? path) : "";
}

export function sessionTitle(s: Session): string {
	const summary = isObj(s.metadata.summary) ? s.metadata.summary.text : undefined;
	const title = typeof summary === "string" && summary.trim() ? summary : s.metadata.name;
	return (typeof title === "string" && title.trim() ? title : sessionTitleFallback(s.metadata.path)) || s.id;
}

export interface ModelChoice {
	id: string;
	name: string;
	description?: string;
}

/** Models the session's agent reported, and the one in effect. */
export function sessionModels(s: Session): { current: string; available: ModelChoice[] } {
	const override = isObj(s.metadata.modelOverrideV1) ? s.metadata.modelOverrideV1.modelId : undefined;
	const applied = isObj(s.metadata.sessionAppliedModelV1) ? s.metadata.sessionAppliedModelV1.modelId : undefined;
	const lists = [s.metadata.sessionModelsV1, s.metadata.acpSessionModelsV1].filter(isObj);
	const reported = lists.map((l) => l.currentModelId).find((v) => typeof v === "string" && v);
	const current = [override, applied, reported].find((v): v is string => typeof v === "string" && v !== "") ?? "";
	const available: ModelChoice[] = [];
	for (const list of lists) {
		for (const m of Array.isArray(list.availableModels) ? list.availableModels : []) {
			if (!isObj(m) || typeof m.id !== "string" || available.some((a) => a.id === m.id)) continue;
			available.push({
				id: m.id,
				name: typeof m.name === "string" && m.name ? m.name : m.id,
				description: typeof m.description === "string" ? m.description : undefined,
			});
		}
	}
	return { current, available };
}

export function pendingRequests(s: Session): PermissionRequest[] {
	const requests = isObj(s.agentState?.requests) ? s.agentState.requests : {};
	return Object.entries(requests)
		.filter((e): e is [string, Obj] => isObj(e[1]))
		.map(([id, r]) => ({
			id,
			tool: typeof r.tool === "string" ? r.tool : "tool",
			kind: typeof r.kind === "string" ? r.kind : undefined,
			arguments: r.arguments,
			createdAt: typeof r.createdAt === "number" ? r.createdAt : undefined,
			occurrenceId: typeof r.occurrenceId === "string" ? r.occurrenceId : undefined,
		}))
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** True while the agent is working on a turn. */
export function isBusy(s: Session): boolean {
	return s.active && (s.thinking || s.latestTurnStatus === "in_progress");
}

/** The relay's queue conflicts, in words. */
function queueError(e: unknown): unknown {
	if (e instanceof HappierError && (e.status === 404 || e.status === 409)) {
		return new HappierError("The message was already handed to the agent.", e.code, e.status);
	}
	return e;
}

/** Error codes worth saying in words. */
const RPC_ERRORS: Array<[RegExp, string]> = [
	[/^unsupported_session_runtime_method|METHOD_NOT_AVAILABLE|not_supported|unsupported/i, "this agent does not support it"],
	[/^usage_limit_issue_unavailable/, "no usage limit is in effect for this session"],
];

/** Throws the error an RPC reported as `{ok:false, …}`. */
function expectOk(res: Obj | null | undefined, what: string): void {
	if (!res || res.ok !== false) return;
	const raw = [res.errorCode, res.error, res.errorMessage].find((v) => typeof v === "string" && v) as string | undefined;
	const known = raw && RPC_ERRORS.find(([re]) => re.test(raw))?.[1];
	const detail = known ?? [res.errorMessage, res.error, res.errorCode].find((v) => typeof v === "string" && v);
	throw new HappierError(`${what}: ${detail ?? "refused by the agent"}`, typeof res.errorCode === "string" ? res.errorCode : undefined);
}

const PLAIN_MACHINE_MARKER = Buffer.from(JSON.stringify({ t: "plain", v: null })).toString("base64");

// --- client ------------------------------------------------------------------

export class HappierClient extends EventEmitter<ClientEvents> {
	readonly sessions = new Map<string, Session>();
	readonly machines = new Map<string, Machine>();
	private socket: Socket | null = null;
	connected = false;

	constructor(readonly config: HappierConfig) {
		super();
	}

	private get keys(): AccountKeys {
		return this.config.keys;
	}

	// --- HTTP ---

	private async http<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetch(`${this.config.serverUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.config.token}`,
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(30_000),
		});
		const text = await res.text();
		let data: unknown;
		try {
			data = text ? JSON.parse(text) : undefined;
		} catch {
			data = undefined;
		}
		if (!res.ok) {
			const err = isObj(data) && typeof data.error === "string" ? data.error : text.slice(0, 200) || res.statusText;
			if (res.status === 401) {
				throw new HappierError("Not authorized — run `happier auth login` again.", "unauthorized", 401);
			}
			throw new HappierError(`${method} ${path.split("?")[0]} failed (${res.status}): ${err}`, err, res.status);
		}
		return data as T;
	}

	// --- keys / content ---

	private sessionKey(row: Obj): ContentKey | null {
		if (row.encryptionMode === "plain") return { variant: "plain" };
		const keys = this.keys;
		if (keys.type === "legacy") return { variant: "legacy", key: keys.secret };
		if (keys.type === "tokenOnly") return null;
		const dek = typeof row.dataEncryptionKey === "string" && row.dataEncryptionKey ? row.dataEncryptionKey : null;
		const opened = dek ? openDataKeyEnvelope(b64decode(dek), keys.machineKey) : null;
		return { variant: "dataKey", key: opened ?? keys.machineKey };
	}

	private machineKey(row: Obj): ContentKey | null {
		const dek = typeof row.dataEncryptionKey === "string" && row.dataEncryptionKey ? row.dataEncryptionKey : null;
		if (dek === PLAIN_MACHINE_MARKER) return { variant: "plain" };
		const keys = this.keys;
		if (keys.type === "tokenOnly") return null;
		if (!dek) {
			return keys.type === "legacy"
				? { variant: "legacy", key: keys.secret }
				: { variant: "dataKey", key: keys.machineKey };
		}
		const recipient = keys.type === "legacy" ? machineKeyFromLegacySecret(keys.secret) : keys.machineKey;
		const opened = openDataKeyEnvelope(b64decode(dek), recipient);
		return opened && opened.length === 32 ? { variant: "dataKey", key: opened } : null;
	}

	/** Decodes a session/machine stored string (metadata, agentState, daemonState). */
	private openStored(key: ContentKey | null, value: unknown, plainEnvelope = false): unknown {
		if (typeof value !== "string" || !value || !key) return null;
		try {
			if (key.variant === "plain") {
				if (!plainEnvelope) return JSON.parse(value);
				const env = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Obj;
				return env.v ?? null;
			}
			return decryptBytes(key, b64decode(value));
		} catch {
			return null;
		}
	}

	private sealStored(key: ContentKey, value: unknown): string {
		return key.variant === "plain" ? JSON.stringify(value) : b64encode(encryptBytes(key, value));
	}

	/** Opens a `{t:'encrypted',c}` / `{t:'plain',v}` message envelope. */
	private openEnvelope(key: ContentKey | null, content: unknown): unknown {
		if (!key) return null;
		if (isObj(content) && content.t === "plain") return content.v;
		const c = typeof content === "string" ? content : isObj(content) && typeof content.c === "string" ? content.c : null;
		if (!c || key.variant === "plain") return null;
		try {
			return decryptBytes(key, b64decode(c));
		} catch {
			return null;
		}
	}

	private toSession(row: Obj, prev?: Session): Session {
		const key = this.sessionKey(row);
		const metadata = this.openStored(key, row.metadata);
		const agentState = this.openStored(key, row.agentState);
		const n = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
		return {
			id: String(row.id),
			seq: n(row.seq),
			createdAt: n(row.createdAt),
			updatedAt: n(row.updatedAt),
			activityAt: Math.max(n(row.meaningfulActivityAt, n(row.updatedAt)), prev?.activityAt ?? 0),
			active: row.active === true,
			activeAt: n(row.activeAt),
			archivedAt: typeof row.archivedAt === "number" ? row.archivedAt : null,
			encryptionMode: row.encryptionMode === "plain" ? "plain" : "e2ee",
			key,
			metadata: isObj(metadata) ? metadata : (prev?.metadata ?? {}),
			metadataVersion: n(row.metadataVersion),
			agentState: isObj(agentState) ? agentState : null,
			agentStateVersion: n(row.agentStateVersion),
			thinking: row.thinking === true,
			latestTurnStatus: typeof row.latestTurnStatus === "string" ? row.latestTurnStatus : null,
			pendingCount: n(row.pendingCount),
			pendingPermissionRequestCount: n(row.pendingPermissionRequestCount),
			pendingUserActionRequestCount: n(row.pendingUserActionRequestCount),
		};
	}

	private toRow(session: Session, m: Obj): MessageRow {
		return {
			id: typeof m.id === "string" ? m.id : undefined,
			seq: typeof m.seq === "number" ? m.seq : undefined,
			localId: typeof m.localId === "string" ? m.localId : null,
			createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
			sidechainId: typeof m.sidechainId === "string" && m.sidechainId ? m.sidechainId : null,
			record: this.openEnvelope(session.key, m.content),
		};
	}

	// --- sessions ---

	/** Loads non-archived sessions (most recent first) into `this.sessions`. */
	async refreshSessions(maxPages = 5): Promise<Session[]> {
		let cursor: string | null = null;
		for (let page = 0; page < maxPages; page++) {
			const q: string = `/v2/sessions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
			const data = await this.http<{ sessions?: Obj[]; nextCursor?: string | null; hasNext?: boolean }>("GET", q);
			for (const row of data.sessions ?? []) {
				const s = this.toSession(row, this.sessions.get(String(row.id)));
				this.sessions.set(s.id, s);
			}
			cursor = data.nextCursor ?? null;
			if (!data.hasNext || !cursor) break;
		}
		return [...this.sessions.values()];
	}

	async refreshSession(id: string): Promise<Session> {
		const data = await this.http<{ session: Obj }>("GET", `/v2/sessions/${encodeURIComponent(id)}`);
		const s = this.toSession(data.session, this.sessions.get(id));
		this.sessions.set(s.id, s);
		this.emit("session", s);
		return s;
	}

	/** Latest page when no bound is given (rows come back newest first). */
	/** A page of the main transcript, or of one subagent's (`sidechainId`). */
	async fetchMessages(
		session: Session,
		opts: { beforeSeq?: number; afterSeq?: number; limit?: number; sidechainId?: string } = {},
	) {
		const q = new URLSearchParams({ limit: String(opts.limit ?? 150) });
		if (opts.sidechainId) {
			q.set("scope", "sidechain");
			q.set("sidechainId", opts.sidechainId);
		}
		if (opts.afterSeq !== undefined) q.set("afterSeq", String(opts.afterSeq));
		else if (opts.beforeSeq !== undefined) q.set("beforeSeq", String(opts.beforeSeq));
		const data = await this.http<{
			messages?: Obj[];
			hasMore?: boolean;
			nextBeforeSeq?: number | null;
			nextAfterSeq?: number | null;
		}>("GET", `/v1/sessions/${encodeURIComponent(session.id)}/messages?${q}`);
		const page: MessagePage = {
			messages: (data.messages ?? []).map((m) => this.toRow(session, m)),
			hasMore: data.hasMore === true,
			nextBeforeSeq: data.nextBeforeSeq ?? null,
			nextAfterSeq: data.nextAfterSeq ?? null,
		};
		return page;
	}

	/**
	 * Queues a user prompt. The relay's pending queue is the only user-input ingress; the
	 * agent runner (or the daemon, for an inactive session) picks it up from there.
	 * Returns the localId under which the prompt will appear in the transcript.
	 */
	async sendMessage(session: Session, text: string): Promise<{ localId: string; record: Obj }> {
		if (session.archivedAt) throw new HappierError("Session is archived.");
		const localId = randomUUID();
		const record = this.promptRecord(session, text);
		const body: Obj = {
			localId,
			messageRole: "user",
			requestedAction: { v: 1, kind: session.active ? "steer_if_active" : "send_now" },
			...this.promptBody(session, record),
		};
		if (!session.active) body.resumeWhenAvailable = true;

		await this.http("POST", `/v2/sessions/${encodeURIComponent(session.id)}/pending`, body);
		if (session.active) {
			// Best-effort nudge; the enqueue itself is the durable wake.
			void this.sessionRpc(session, "session.pendingQueue.wake.v1", { protocolVersion: 1 }, 10_000).catch(() => {});
		}
		return { localId, record };
	}

	/** A user prompt record, carrying the session's current mode, model and effort choices. */
	private promptRecord(session: Session, text: string): Obj {
		const meta: Obj = { sentFrom: "cli", source: "ui" };
		const mode = session.metadata.permissionMode;
		if (typeof mode === "string" && mode) meta.permissionMode = mode;
		const override = isObj(session.metadata.modelOverrideV1) ? session.metadata.modelOverrideV1.modelId : undefined;
		if (typeof override === "string" && override && override !== "default") meta.model = override;
		// Claude takes the effort with each prompt as well as from metadata.
		const effort = effortOverride(session.metadata);
		if (effort && session.metadata.flavor === "claude") meta.reasoningEffort = effort;

		return { role: "user", content: { type: "text", text }, meta };
	}

	/** The encrypted (or plain) content fields of a pending-queue write. */
	private promptBody(session: Session, record: Obj): Obj {
		if (!session.key) throw new HappierError("No key available to write to this session.");
		return session.key.variant === "plain"
			? { content: { t: "plain", v: record } }
			: { ciphertext: b64encode(encryptBytes(session.key, record)) };
	}

	/** Interrupts the current turn. Resolves false when no runner is attached. */
	async abort(session: Session): Promise<boolean> {
		try {
			await this.sessionRpc(session, "abort", { reason: "Aborted by user" });
			return true;
		} catch (e) {
			if (e instanceof HappierError && e.code === "RPC_METHOD_NOT_AVAILABLE") return false;
			throw e;
		}
	}

	async respondPermission(
		session: Session,
		req: PermissionRequest,
		decision: "approved" | "approved_for_session" | "denied" | "abort",
	): Promise<void> {
		const approved = decision === "approved" || decision === "approved_for_session";
		const payload: Obj = { id: req.id, approved, decision };
		if (req.occurrenceId) payload.occurrenceId = req.occurrenceId;
		if (decision === "approved_for_session") payload.allowedTools = [req.tool];
		const method = req.occurrenceId ? "session.permission.respondToOccurrence.v1" : "permission";
		try {
			await this.sessionRpc(session, method, payload);
		} catch (e) {
			const code = e instanceof HappierError ? e.code : undefined;
			if (method === "permission" || (code !== "RPC_METHOD_NOT_FOUND" && code !== "RPC_METHOD_NOT_AVAILABLE")) throw e;
			await this.sessionRpc(session, "permission", payload);
		}
		if (decision === "abort") await this.abort(session).catch(() => false);
	}

	/** Answers an AskUserQuestion-style request. `answers` maps question text to chosen labels. */
	async respondQuestion(session: Session, req: PermissionRequest, answers: Record<string, string[]>): Promise<void> {
		const caps = isObj(session.agentState?.capabilities) ? session.agentState.capabilities : {};
		if (caps.structuredQuestionAnswersV1Supported === true) {
			const payload: Obj = { id: req.id, structuredAnswersV1: answers };
			if (req.occurrenceId) payload.occurrenceId = req.occurrenceId;
			await this.sessionRpc(session, "session.structuredQuestion.respond.v1", payload);
			return;
		}
		const joined = Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, a.join(", ")]));
		await this.sessionRpc(session, "permission", { id: req.id, approved: true, answers: joined });
	}

	/** Versioned read-modify-write of the encrypted session metadata. */
	async updateMetadata(session: Session, mutate: (metadata: Obj) => Obj): Promise<Session> {
		let current = session;
		for (let attempt = 0; attempt < 6; attempt++) {
			if (!current.key) throw new HappierError("No key available to write to this session.");
			const next = mutate({ ...current.metadata });
			const sealed = this.sealStored(current.key, next);
			try {
				const res = await this.http<Obj>("PATCH", `/v2/sessions/${encodeURIComponent(current.id)}`, {
					metadata: { ciphertext: sealed, expectedVersion: current.metadataVersion },
				});
				if (res?.success === false) throw new HappierError("version-mismatch", "version-mismatch");
				return await this.refreshSession(current.id);
			} catch (e) {
				const mismatch = e instanceof HappierError && (e.code === "version-mismatch" || e.status === 409);
				if (!mismatch) throw e;
				current = await this.refreshSession(current.id);
			}
		}
		throw new HappierError("Could not update session metadata (concurrent changes).");
	}

	setPermissionMode(session: Session, mode: string): Promise<Session> {
		return this.updateMetadata(session, (m) => ({ ...m, permissionMode: mode, permissionModeUpdatedAt: Date.now() }));
	}

	/** Sets the session's model override; the runner applies it from the next prompt. */
	setModel(session: Session, modelId: string): Promise<Session> {
		return this.updateMetadata(session, (m) => {
			const prev = isObj(m.modelOverrideV1) && typeof m.modelOverrideV1.updatedAt === "number" ? m.modelOverrideV1.updatedAt : 0;
			return { ...m, modelOverrideV1: { v: 1, updatedAt: Math.max(Date.now(), prev + 1), modelId } };
		});
	}

	/** Waits (up to ~10 s) for a session just created elsewhere to be readable here. */
	async waitForSession(id: string): Promise<Session | undefined> {
		for (let i = 0; i < 20 && !this.sessions.has(id); i++) {
			await this.refreshSession(id).catch(() => undefined);
			if (!this.sessions.has(id)) await new Promise((r) => setTimeout(r, 500));
		}
		return this.sessions.get(id);
	}

	/** Waits up to ~15 s for a stopped session to be reported inactive; whether it was. */
	async waitStopped(id: string): Promise<boolean> {
		for (let i = 0; i < 30; i++) {
			const s = await this.refreshSession(id).catch(() => undefined);
			if (!s?.active) return true;
			await new Promise((r) => setTimeout(r, 500));
		}
		return false;
	}

	/** Selects one of the agent's own modes (ACP agents); null returns to the agent's default. */
	setMode(session: Session, modeId: string | null): Promise<Session> {
		return this.updateMetadata(session, (m) => withModeOverride(m, modeId));
	}

	/** Sets a model or agent option such as `reasoning_effort`; applies from the next prompt. */
	setOption(session: Session, id: string, value: string): Promise<Session> {
		return this.updateMetadata(session, (m) => withConfigOverride(m, id, value));
	}

	rename(session: Session, title: string): Promise<Session> {
		return this.updateMetadata(session, (m) => ({ ...m, summary: { text: title, updatedAt: Date.now() } }));
	}

	// --- pending queue ---

	async listQueue(session: Session): Promise<QueuedPrompt[]> {
		const data = await this.http<{ pending?: Obj[] }>("GET", `/v2/sessions/${encodeURIComponent(session.id)}/pending`);
		return (data.pending ?? [])
			.filter((p) => p.status !== "discarded" && typeof p.localId === "string")
			.map((p) => {
				const record = this.openEnvelope(session.key, p.content);
				const content = isObj(record) && isObj(record.content) ? record.content : undefined;
				const meta = isObj(record) && isObj(record.meta) ? record.meta : undefined;
				const text = typeof meta?.displayText === "string" ? meta.displayText : typeof content?.text === "string" ? content.text : "";
				const delivery = isObj(p.deliveryStatus) ? p.deliveryStatus.status : undefined;
				return {
					localId: String(p.localId),
					text,
					createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
					delivering: delivery === "delivering" || delivery === "external_handoff",
				};
			});
	}

	async cancelQueued(session: Session, localId: string): Promise<void> {
		await this.http("DELETE", `/v2/sessions/${encodeURIComponent(session.id)}/pending/${encodeURIComponent(localId)}`).catch((e) => {
			if (!(e instanceof HappierError && e.status === 404)) throw queueError(e); // 404: already delivered or gone
		});
	}

	async editQueued(session: Session, localId: string, text: string): Promise<void> {
		const body = this.promptBody(session, this.promptRecord(session, text));
		await this.http("PATCH", `/v2/sessions/${encodeURIComponent(session.id)}/pending/${encodeURIComponent(localId)}`, {
			...body,
			messageRole: "user",
		}).catch((e) => {
			throw queueError(e);
		});
	}

	// --- branching ---

	/**
	 * Forks the session into a new one holding the conversation up to `seq` (inclusive), or all of
	 * it. Resolves the new session's id. Agents without native forking get a replayed summary.
	 */
	async fork(session: Session, seq: number | null): Promise<string> {
		const machine = await this.sessionMachine(session);
		const res = (await this.machineRpc(
			machine,
			"session.fork",
			{
				v: 1,
				parentSessionId: session.id,
				forkPoint: seq === null ? { type: "latest" } : { type: "seq", upToSeqInclusive: seq },
				requestId: randomUUID(),
			},
			180_000,
		)) as Obj;
		expectOk(res, "Fork failed");
		if (typeof res.childSessionId !== "string") throw new HappierError("Fork failed: no session returned.");
		return res.childSessionId;
	}

	/** Undoes the conversation from a user message onwards (agents that support it: Codex). */
	async rollback(session: Session, userMessageSeq: number): Promise<void> {
		const res = (await this.sessionRpc(session, "session.rollback", {
			v: 1,
			target: { type: "before_user_message", userMessageSeq },
		})) as Obj;
		expectOk(res, "Rollback failed");
	}

	// --- goal and usage limit ---

	/** Sets (objective) or clears (null) the session's goal. */
	async setGoal(session: Session, objective: string | null): Promise<void> {
		const params = objective === null ? {} : { objective, status: "active" };
		const res = session.active
			? await this.sessionRpc(session, objective === null ? "session.goal.clear" : "session.goal.set", params)
			: await this.machineRpc(await this.sessionMachine(session), objective === null ? "daemon.sessionGoal.clear" : "daemon.sessionGoal.set", {
					...params,
					sessionId: session.id,
				});
		expectOk(res as Obj, "Goal not updated");
	}

	/**
	 * Usage-limit recovery: arm automatic resume when the limit resets, cancel it, or check now.
	 * Goes to the agent while it runs, to its machine's daemon otherwise.
	 */
	async usageLimitAction(session: Session, action: "waitResume.enable" | "waitResume.cancel" | "checkNow"): Promise<Obj> {
		const u = usageLimit(session.metadata);
		const params: Obj = { sessionId: session.id };
		if (action === "waitResume.cancel") Object.assign(params, { issueFingerprint: u?.issueFingerprint ?? null, armedAtMs: u?.armedAtMs, runtimeAuthRecoveryAttemptId: u?.attemptId });
		else if (u?.issueFingerprint && action === "waitResume.enable") params.issueFingerprint = u.issueFingerprint;
		const res = (session.active
			? await this.sessionRpc(session, `session.usageLimit.${action}`, params)
			: await this.machineRpc(await this.sessionMachine(session), `daemon.sessionUsageLimit.${action}`, params)) as Obj;
		expectOk(res, "Usage limit");
		return res;
	}

	/** Whether the account keeps account-wide records sealed ("e2ee") or in the clear ("plain"). */
	private encryptionMode?: Promise<string>;

	/**
	 * The provider usage records the session's agent reported (plan limits such as Claude's 5-hour
	 * and weekly windows), opened. The CLI lists their ids in the session metadata.
	 */
	async providerUsageRecords(session: Session): Promise<Obj[]> {
		const refs = session.metadata.providerAccountUsageRefsV1;
		const ids = isObj(refs) && Array.isArray(refs.recordIds) ? refs.recordIds.filter((id): id is string => typeof id === "string") : [];
		if (ids.length === 0) return [];
		this.encryptionMode ??= this.http<Obj>("GET", "/v1/account/encryption").then((r) => String(r.mode ?? "e2ee"));
		const sealed = (await this.encryptionMode) !== "plain";
		const keys = this.keys;
		const machineKey = keys.type === "dataKey" ? keys.machineKey : keys.type === "legacy" ? machineKeyFromLegacySecret(keys.secret) : null;
		const records = await Promise.all(
			ids.map(async (id) => {
				const path = `/${sealed ? "v2" : "v3"}/connect/provider-account-usage/${encodeURIComponent(id)}`;
				const res = await this.http<Obj>("GET", path).catch((e) => {
					if (e instanceof HappierError && e.status === 404) return null;
					throw e;
				});
				if (!res) return null;
				if (!sealed) return isObj(res.content) && res.content.t === "plain" ? res.content.v : null;
				const box = isObj(res.sealed) ? res.sealed.ciphertext : undefined;
				return typeof box === "string" && machineKey ? openAccountScoped(machineKey, "provider_account_usage_snapshot", box) : null;
			}),
		);
		return records.filter(isObj);
	}

	private async sessionMachine(session: Session): Promise<Machine> {
		const machineId = session.metadata.machineId;
		const machine = typeof machineId === "string" ? await this.getMachine(machineId) : undefined;
		if (!machine) throw new HappierError("The session's machine is unknown.");
		if (!machine.active) throw new HappierError(`${machine.metadata.displayName ?? machine.metadata.host ?? "The machine"} is offline.`);
		return machine;
	}

	async archive(session: Session): Promise<void> {
		await this.http("POST", `/v2/sessions/${encodeURIComponent(session.id)}/archive`, {});
		this.sessions.delete(session.id);
		this.emit("session-removed", session.id);
	}

	/** Stops the session's runner process on its machine. */
	async stopSession(session: Session): Promise<void> {
		const machineId = session.metadata.machineId;
		const machine = typeof machineId === "string" ? await this.getMachine(machineId) : undefined;
		if (!machine) throw new HappierError("The session's machine is unknown.");
		await this.machineRpc(machine, "stop-session", { sessionId: session.id, source: "cli" }, 30_000, {
			kind: "session.write",
			sessionId: session.id,
		});
	}

	// --- machines ---

	async refreshMachines(): Promise<Machine[]> {
		const rows = await this.http<Obj[]>("GET", "/v1/machines");
		this.machines.clear();
		for (const row of Array.isArray(rows) ? rows : []) {
			if (row.revokedAt || row.replacedByMachineId) continue;
			const key = this.machineKey(row);
			const plain = key?.variant === "plain";
			const metadata = this.openStored(key, row.metadata, plain);
			const daemonState = this.openStored(key, row.daemonState, plain);
			this.machines.set(String(row.id), {
				id: String(row.id),
				active: row.active === true,
				activeAt: typeof row.activeAt === "number" ? row.activeAt : 0,
				key,
				metadata: isObj(metadata) ? metadata : {},
				daemonState: isObj(daemonState) ? daemonState : null,
			});
		}
		return [...this.machines.values()];
	}

	async getMachine(id: string): Promise<Machine | undefined> {
		if (!this.machines.has(id)) await this.refreshMachines();
		return this.machines.get(id);
	}

	async listDirectory(machine: Machine, path: string): Promise<{ path: string; dirs: string[] }> {
		const res = (await this.machineRpc(machine, "daemon.filesystem.listDirectory", {
			path,
			includeFiles: false,
			maxEntries: 500,
		})) as Obj;
		if (res?.ok !== true) throw new HappierError(typeof res?.error === "string" ? res.error : "Cannot list directory");
		const entries = Array.isArray(res.entries) ? (res.entries as Obj[]) : [];
		return {
			path: typeof res.path === "string" ? res.path : path,
			dirs: entries
				.filter((e) => e.type === "directory" || e.type === "dir")
				.map((e) => String(e.name))
				.sort((a, b) => a.localeCompare(b)),
		};
	}

	/**
	 * Files under the session's directory, relative to it, as listed by ripgrep on the session's
	 * machine (so .gitignore is honoured). This is how the Happier app indexes `@` mentions.
	 */
	async listFiles(session: Session): Promise<string[]> {
		const machineId = session.metadata.machineId;
		const machine = typeof machineId === "string" ? await this.getMachine(machineId) : undefined;
		const cwd = session.metadata.path;
		if (!machine?.active || typeof cwd !== "string") return [];
		const res = (await this.machineRpc(machine, "ripgrep", { args: ["--files", "--follow"], cwd }, 20_000)) as Obj;
		if (res?.success !== true || typeof res.stdout !== "string") {
			throw new HappierError(typeof res?.error === "string" ? res.error : "Cannot list files");
		}
		return res.stdout.split("\n").filter(Boolean).slice(0, 50_000);
	}

	/** Agent backends whose CLI is installed on the machine (best effort). */
	async detectAgents(machine: Machine): Promise<string[]> {
		const res = (await this.machineRpc(machine, "capabilities.detect", { checklistId: "new-session" }, 120_000)) as Obj;
		const results = isObj(res?.results) ? res.results : {};
		return Object.entries(results)
			.filter(([id, r]) => id.startsWith("cli.") && isObj(r) && isObj(r.data) && r.data.available === true)
			.map(([id]) => id.slice(4));
	}

	/**
	 * Asks the machine's daemon which models an agent offers there. Used when a session has not
	 * reported its own list yet (a fresh session only does so once the agent has started a turn).
	 */
	async probeModels(machine: Machine, agent: string, cwd?: string): Promise<ModelChoice[]> {
		const params: Obj = { backendTarget: { kind: "builtInAgent", agentId: agent } };
		if (cwd) params.cwd = cwd;
		const res = (await this.machineRpc(
			machine,
			"capabilities.invoke",
			{ id: `cli.${agent}`, method: "probeModels", params },
			60_000,
		)) as Obj;
		const result = isObj(res?.result) ? res.result : {};
		const out: ModelChoice[] = [];
		for (const m of Array.isArray(result.availableModels) ? result.availableModels : []) {
			if (!isObj(m) || typeof m.id !== "string" || !m.id || m.id === "default") continue;
			out.push({
				id: m.id,
				name: typeof m.name === "string" && m.name ? m.name : m.id,
				description: typeof m.description === "string" ? m.description : undefined,
			});
		}
		return out;
	}

	/** Starts a new agent session on a machine. The daemon creates the session and its key. */
	async spawnSession(
		machine: Machine,
		opts: { directory: string; agent: string; approveNewDirectory?: boolean; permissionMode?: string },
	): Promise<SpawnResult> {
		const params: Obj = {
			type: "spawn-in-directory",
			machineId: machine.id,
			directory: opts.directory,
			backendTarget: { kind: "builtInAgent", agentId: opts.agent },
			spawnNonce: randomUUID(),
		};
		if (opts.approveNewDirectory) params.approvedNewDirectoryCreation = true;
		if (opts.permissionMode) {
			params.permissionMode = opts.permissionMode;
			params.permissionModeUpdatedAt = Date.now();
		}
		const res = (await this.machineRpc(machine, "spawn-happy-session", params, 300_000)) as Obj;
		if (res?.type === "success") {
			return { type: "success", sessionId: typeof res.sessionId === "string" ? res.sessionId : undefined };
		}
		if (res?.type === "requestToApproveDirectoryCreation") {
			return { type: "requestToApproveDirectoryCreation", directory: String(res.directory ?? opts.directory) };
		}
		const msg = typeof res?.errorMessage === "string" ? res.errorMessage : "Spawn failed";
		return { type: "error", errorMessage: msg };
	}

	// --- RPC ---

	private waitConnected(socket: Socket, ms = 8_000): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				socket.off("connect", done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			socket.on("connect", done);
		});
	}

	private async rpc(
		key: ContentKey | null,
		method: string,
		params: unknown,
		timeoutMs: number,
		authorization?: Obj,
	): Promise<unknown> {
		const socket = this.socket;
		// A call made right after start-up (or during a reconnect) waits for the socket briefly.
		if (socket && !socket.connected) await this.waitConnected(socket);
		if (!socket?.connected) throw new HappierError("Not connected to the relay.", "not_connected");
		if (!key) throw new HappierError("No key available for this target.");
		const payload: Obj = {
			method,
			params: key.variant === "plain" ? params : b64encode(encryptBytes(key, params)),
			requestId: randomUUID(),
			timeoutMs,
		};
		if (authorization) payload.authorization = authorization;
		let ack: unknown;
		try {
			ack = await socket.timeout(timeoutMs + 5_000).emitWithAck("rpc-call", payload);
		} catch {
			throw new HappierError(`RPC ${method.split(":").pop()} timed out.`, "timeout");
		}
		if (!isObj(ack) || ack.ok !== true) {
			const code = isObj(ack) && typeof ack.errorCode === "string" ? ack.errorCode : undefined;
			const error = isObj(ack) && typeof ack.error === "string" ? ack.error : "RPC failed";
			const friendly = code === "RPC_METHOD_NOT_AVAILABLE" ? "Target is offline (no runner or daemon connected)." : error;
			throw new HappierError(friendly, code);
		}
		let result: unknown = ack.result;
		if (key.variant !== "plain" && typeof result === "string") {
			result = decryptBytes(key, b64decode(result));
			if (result === null) throw new HappierError("Could not decrypt RPC response.");
		}
		// Errors raised inside the target come back as a successful ack carrying an error body.
		if (isObj(result) && typeof result.error === "string" && !("ok" in result) && !("type" in result)) {
			throw new HappierError(result.error, typeof result.errorCode === "string" ? result.errorCode : undefined);
		}
		if (isObj(result) && result.type === "socket-rpc-target-failure-v1") {
			throw new HappierError(String(result.error ?? "RPC failed"), String(result.errorCode ?? ""));
		}
		return result;
	}

	sessionRpc(session: Session, name: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
		return this.rpc(session.key, `${session.id}:${name}`, params, timeoutMs);
	}

	machineRpc(machine: Machine, name: string, params: unknown, timeoutMs = 30_000, auth?: Obj): Promise<unknown> {
		return this.rpc(machine.key, `${machine.id}:${name}`, params, timeoutMs, auth);
	}

	// --- realtime ---

	connect(): void {
		if (this.socket) return;
		this.emit("connection", "connecting");
		const socket = io(this.config.serverUrl, {
			path: "/v1/updates",
			// `clientPurpose: 'sync'` marks this as an interactive UI connection; the relay only
			// accepts `ui-focus` presence from such sockets.
			auth: { token: this.config.token, clientType: "user-scoped", clientPurpose: "sync" },
			transports: ["websocket", "polling"],
			reconnection: true,
			reconnectionDelay: 1_000,
			reconnectionDelayMax: 15_000,
		});
		this.socket = socket;
		socket.on("connect", () => {
			this.connected = true;
			// Presence lives on the socket, so it has to be declared again after every (re)connect.
			this.emitUiFocus();
			this.emit("connection", "connected");
		});
		socket.on("disconnect", (reason) => {
			this.connected = false;
			this.emit("connection", "disconnected", reason);
		});
		socket.on("connect_error", (err) => {
			this.connected = false;
			this.emit("connection", "disconnected", err.message);
		});
		socket.on("update", (update: unknown) => {
			try {
				if (isObj(update) && isObj(update.body)) this.onUpdate(update.body);
			} catch {
				// A malformed update must never take the client down.
			}
		});
		socket.on("ephemeral", (ev: unknown) => {
			try {
				if (isObj(ev)) this.onEphemeral(ev);
			} catch {
				// ignore
			}
		});
	}

	private uiFocused = false;

	/**
	 * Tells the relay whether the user is present at this computer. With the account option
	 * "Mute phone while a computer is focused" enabled, agent runners skip phone pushes for
	 * finished turns and permission requests while any computer UI reports focus.
	 */
	setUiFocus(focused: boolean): void {
		if (focused === this.uiFocused) return;
		this.uiFocused = focused;
		this.emitUiFocus();
	}

	private emitUiFocus(): void {
		// The relay validates this payload strictly: exactly these two keys.
		if (this.socket?.connected) this.socket.emit("ui-focus", { computer: true, focused: this.uiFocused });
	}

	/** Marks the session read up to `seq` so other devices clear their unread badge. */
	markRead(session: Session, seq: number): void {
		if (!this.socket?.connected || seq <= 0) return;
		this.socket.emit("update-read-cursor", { sid: session.id, lastViewedSessionSeq: seq });
	}

	close(): void {
		this.socket?.removeAllListeners();
		this.socket?.disconnect();
		this.socket = null;
		this.connected = false;
	}

	private onUpdate(body: Obj): void {
		switch (body.t) {
			case "new-message":
			case "message-updated": {
				const sid = String(body.sid);
				const session = this.sessions.get(sid);
				if (!session || !isObj(body.message)) return;
				const row = this.toRow(session, body.message);
				if (row.seq !== undefined && row.seq > session.seq) session.seq = row.seq;
				session.activityAt = Math.max(session.activityAt, row.createdAt);
				this.emit("message", sid, row);
				return;
			}
			case "new-session": {
				const s = this.toSession(body);
				this.sessions.set(s.id, s);
				this.emit("session", s);
				return;
			}
			case "update-session": {
				const id = String(body.id);
				const s = this.sessions.get(id);
				if (!s) {
					void this.refreshSession(id).catch(() => {});
					return;
				}
				if (isObj(body.metadata) && typeof body.metadata.version === "number") {
					if (body.metadata.version >= s.metadataVersion) {
						const md = this.openStored(s.key, body.metadata.value);
						if (isObj(md)) s.metadata = md;
						s.metadataVersion = body.metadata.version;
					}
				}
				if (isObj(body.agentState) && typeof body.agentState.version === "number") {
					if (body.agentState.version >= s.agentStateVersion) {
						const st = this.openStored(s.key, body.agentState.value);
						s.agentState = isObj(st) ? st : null;
						s.agentStateVersion = body.agentState.version;
					}
				}
				if (typeof body.active === "boolean") s.active = body.active;
				if (typeof body.activeAt === "number") s.activeAt = body.activeAt;
				if ("archivedAt" in body) s.archivedAt = typeof body.archivedAt === "number" ? body.archivedAt : null;
				if (typeof body.thinking === "boolean") s.thinking = body.thinking;
				if ("latestTurnStatus" in body) {
					const status = typeof body.latestTurnStatus === "string" ? body.latestTurnStatus : null;
					if (status !== s.latestTurnStatus) s.activityAt = Date.now();
					s.latestTurnStatus = status;
					s.thinking = status === "in_progress";
				}
				if (typeof body.meaningfulActivityAt === "number") {
					s.activityAt = Math.max(s.activityAt, body.meaningfulActivityAt);
				}
				for (const k of ["pendingCount", "pendingPermissionRequestCount", "pendingUserActionRequestCount"] as const) {
					if (typeof body[k] === "number") s[k] = body[k];
				}
				if (s.archivedAt) {
					this.sessions.delete(id);
					this.emit("session-removed", id);
				} else {
					this.emit("session", s);
				}
				return;
			}
			case "pending-changed": {
				const s = this.sessions.get(String(body.sid));
				if (s && typeof body.pendingCount === "number") {
					s.pendingCount = body.pendingCount;
					this.emit("session", s);
				}
				return;
			}
			case "delete-session": {
				const id = String(body.sid);
				if (this.sessions.delete(id)) this.emit("session-removed", id);
				return;
			}
			default:
				return;
		}
	}

	private onEphemeral(ev: Obj): void {
		switch (ev.type) {
			case "activity": {
				const s = this.sessions.get(String(ev.id));
				if (!s) return;
				const active = ev.active === true;
				const thinking = typeof ev.thinking === "boolean" ? ev.thinking : s.thinking;
				if (typeof ev.activeAt === "number") s.activeAt = ev.activeAt;
				if (active === s.active && thinking === s.thinking) return;
				s.active = active;
				s.thinking = thinking;
				this.emit("session", s);
				return;
			}
			case "transcript-stream-segment":
			case "transcript-stream-segment-delta": {
				const sid = String(ev.sessionId);
				const session = this.sessions.get(sid);
				if (!session || !isObj(ev.message)) return;
				const row = this.toRow(session, ev.message);
				if (!row.localId || row.record === null) return;
				row.seq = undefined;
				if (ev.type === "transcript-stream-segment") {
					this.emit("stream-segment", sid, row);
					return;
				}
				const rec = row.record;
				const data = isObj(rec) && isObj(rec.content) && isObj(rec.content.data) ? rec.content.data : undefined;
				const text = typeof data?.message === "string" ? data.message : typeof data?.text === "string" ? data.text : "";
				const base = typeof ev.message.baseLength === "number" ? ev.message.baseLength : -1;
				if (text) this.emit("stream-delta", sid, row.localId, text, base);
				return;
			}
			case "machine-activity": {
				const m = this.machines.get(String(ev.id));
				if (!m) return;
				m.active = ev.active === true;
				if (typeof ev.activeAt === "number") m.activeAt = ev.activeAt;
				this.emit("machine", m);
				return;
			}
			default:
				return;
		}
	}
}
