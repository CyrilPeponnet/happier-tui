/**
 * Session controls kept in session metadata: agent modes, per-model options such as reasoning
 * effort, the goal and the usage-limit recovery state. Readers and pure metadata mutators here;
 * the client writes the result. Shapes follow packages/protocol/src/sessionMetadata and
 * packages/agents/src/sessionControls/publish.ts upstream.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const stampOf = (v: unknown): number => (isObj(v) ? (num(v.updatedAt) ?? 0) : 0);

/**
 * Most metadata controls exist under a current and a legacy (`acp…`) key. Readers take the newer
 * one; writers write both, as the Happier app does.
 */
const KEYS = {
	modes: ["sessionModesV1", "acpSessionModesV1"],
	modeOverride: ["sessionModeOverrideV1", "acpSessionModeOverrideV1"],
	models: ["sessionModelsV1", "acpSessionModelsV1"],
	configOptions: ["sessionConfigOptionsV1", "acpConfigOptionsV1"],
	configOverrides: ["sessionConfigOptionOverridesV1", "acpConfigOptionOverridesV1"],
} as const;

function newest(m: Obj, keys: readonly string[]): Obj | undefined {
	let best: Obj | undefined;
	for (const k of keys) {
		const v = m[k];
		if (isObj(v) && (!best || stampOf(v) > stampOf(best))) best = v;
	}
	return best;
}

/** A stamp strictly newer than what is stored, so "latest wins" arbitration picks this write. */
function nextStamp(m: Obj, keys: readonly string[]): number {
	return Math.max(Date.now(), ...keys.map((k) => stampOf(m[k]) + 1));
}

function writeBoth(m: Obj, keys: readonly string[], value: Obj): Obj {
	return { ...m, ...Object.fromEntries(keys.map((k) => [k, value])) };
}

export interface Choice {
	value: string;
	name: string;
	description?: string;
}

// --- agent modes -------------------------------------------------------------

/** Modes the agent reported (ACP agents), and the one in effect. Empty when it reports none. */
export function sessionModes(m: Obj): { current: string; available: Choice[] } {
	const reported = newest(m, KEYS.modes);
	const available = (Array.isArray(reported?.availableModes) ? reported.availableModes : [])
		.filter(isObj)
		.flatMap((x) => (str(x.id) ? [{ value: String(x.id), name: str(x.name) ?? String(x.id), description: str(x.description) }] : []));
	const override = newest(m, KEYS.modeOverride);
	const current = str(override?.modeId) ?? str(reported?.currentModeId) ?? "";
	return { current, available };
}

export function withModeOverride(m: Obj, modeId: string | null): Obj {
	return writeBoth(m, KEYS.modeOverride, { v: 1, updatedAt: nextStamp(m, KEYS.modeOverride), modeId });
}

// --- options (reasoning effort, …) -------------------------------------------

export interface SessionOption {
	id: string;
	name: string;
	current: string;
	choices: Choice[];
}

/**
 * Selectable options for the session: those of the model in effect (Claude, Pi) plus the agent's
 * own configuration options (ACP). The user's override, when newer, is what counts as current.
 */
export function sessionOptions(m: Obj, modelId: string): SessionOption[] {
	const models = newest(m, KEYS.models);
	const model = (Array.isArray(models?.availableModels) ? models.availableModels : [])
		.filter(isObj)
		.find((x) => x.id === modelId);
	const config = newest(m, KEYS.configOptions);
	const raw = [
		...(Array.isArray(model?.modelOptions) ? model.modelOptions : []),
		...(Array.isArray(config?.configOptions) ? config.configOptions : []),
	].filter(isObj);
	const overrides = newest(m, KEYS.configOverrides);
	const chosen = isObj(overrides?.overrides) ? overrides.overrides : {};

	const out: SessionOption[] = [];
	for (const o of raw) {
		const id = str(o.id);
		if (!id || out.some((x) => x.id === id) || !Array.isArray(o.options)) continue;
		const choices = o.options
			.filter(isObj)
			.filter((x) => x.value !== null && x.value !== undefined)
			.map((x) => ({ value: String(x.value), name: str(x.name) ?? String(x.value), description: str(x.description) }));
		if (choices.length === 0) continue;
		const picked = isObj(chosen[id]) ? chosen[id].value : undefined;
		const current = picked !== undefined && picked !== null ? String(picked) : o.currentValue == null ? "" : String(o.currentValue);
		out.push({ id, name: str(o.name) ?? id, current, choices });
	}
	return out;
}

export function withConfigOverride(m: Obj, id: string, value: string): Obj {
	const updatedAt = nextStamp(m, KEYS.configOverrides);
	const prev = newest(m, KEYS.configOverrides);
	const overrides = { ...(isObj(prev?.overrides) ? prev.overrides : {}), [id]: { updatedAt, value } };
	return writeBoth(m, KEYS.configOverrides, { v: 1, updatedAt, overrides });
}

/** Claude Code's effort levels, for Claude sessions that do not publish their model's own. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** The reasoning-effort override, for agents that also take it with each prompt (Claude). */
export function effortOverride(m: Obj): string | undefined {
	const overrides = newest(m, KEYS.configOverrides);
	const entry = isObj(overrides?.overrides) ? overrides.overrides.reasoning_effort : undefined;
	return isObj(entry) ? str(entry.value) : undefined;
}

// --- goal --------------------------------------------------------------------

export interface Goal {
	title: string;
	status: string;
	reason?: string;
}

/** The session's goal, from the work state the runner publishes (`sessionWorkStateV1`). */
export function sessionGoal(m: Obj): Goal | null {
	const ws = isObj(m.sessionWorkStateV1) ? m.sessionWorkStateV1 : undefined;
	const items = (Array.isArray(ws?.items) ? ws.items : []).filter(isObj).filter((i) => i.kind === "goal");
	const goal = items.find((i) => i.id === ws?.primaryItemId) ?? items[0];
	if (!goal || !str(goal.title)) return null;
	return { title: String(goal.title), status: str(goal.status) ?? "unknown", reason: str(goal.statusReason) };
}

// --- usage limit ---------------------------------------------------------------

export interface UsageLimit {
	/** armed / waiting / checking: the session resumes by itself when the limit resets. */
	status: string;
	resetAt?: number;
	nextCheckAt?: number;
	issueFingerprint?: string;
	armedAtMs?: number;
	attemptId?: string;
}

/** Wait-and-resume state after a provider usage limit (`sessionUsageLimitRecoveryV1`). */
export function usageLimit(m: Obj): UsageLimit | null {
	const r = isObj(m.sessionUsageLimitRecoveryV1) ? m.sessionUsageLimitRecoveryV1 : undefined;
	if (!r || !str(r.status) || r.status === "cancelled") return null;
	return {
		status: String(r.status),
		resetAt: num(r.resetAtMs),
		nextCheckAt: num(r.nextCheckAtMs),
		issueFingerprint: str(r.issueFingerprint),
		armedAtMs: num(r.armedAtMs),
		attemptId: str(r.runtimeAuthRecoveryAttemptId),
	};
}

/** Whether a usage-limit recovery is under way, i.e. the session will resume by itself. */
export const isWaitingForLimit = (u: UsageLimit | null): boolean =>
	!!u && ["armed", "waiting", "checking"].includes(u.status);
