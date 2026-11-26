/**
 * Plan limits from provider usage records (packages/protocol/src/connect/accountUsage.ts), as the
 * Happier app picks them for its usage rings (connectedServiceQuotaGauge.ts): usage and rate
 * limits with a percentage, for the session's provider, from the newest record.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export interface PlanLimit {
	/** "5h", "wk", "day". */
	short: string;
	/** "5-hour", "Weekly". */
	label: string;
	usedPct: number;
	resetAt?: number;
	/** When the agent last reported it. */
	reportedAt?: number;
}

const DAY = 86_400_000;

function usedPct(m: Obj): number | undefined {
	const used = num(m.utilizationPct) ?? num(m.usedPct);
	if (used !== undefined) return used;
	const remaining = num(m.remainingPct);
	if (remaining !== undefined) return 100 - remaining;
	const [u, l] = [num(m.used), num(m.limit)];
	return u !== undefined && l ? (u / l) * 100 : undefined;
}

/** Short name of a limit's window, from its duration or, without one, its name. */
function windowName(m: Obj): { short: string; order: number } {
	const ms = num(m.windowDurationMs);
	if (ms) return { short: ms < DAY ? `${Math.round(ms / 3_600_000)}h` : ms < 2 * DAY ? "day" : ms < 8 * DAY ? "wk" : "mo", order: ms };
	const name = `${m.meterId} ${m.label}`.toLowerCase();
	if (/week|seven/.test(name)) return { short: "wk", order: 7 * DAY };
	if (/day|daily/.test(name)) return { short: "day", order: DAY };
	if (/hour|session|5h/.test(name)) return { short: "5h", order: 5 * 3_600_000 };
	return { short: String(m.label ?? m.meterId).toLowerCase().slice(0, 4), order: 30 * DAY };
}

/**
 * The plan limits to show for a session of `provider` ("claude", "codex"), shortest window
 * first. A limit whose window has reset since it was reported shows as unused.
 */
export function planLimits(records: unknown[], provider: string | undefined, model?: string, now = Date.now()): PlanLimit[] {
	const usable = records
		.filter(isObj)
		.filter((r) => (!provider || r.providerId === provider) && r.state !== "not_loaded" && r.state !== "loaded_empty")
		.filter((r) => Array.isArray(r.meters) && r.meters.length > 0)
		.sort((a, b) => (num(b.fetchedAtMs) ?? 0) - (num(a.fetchedAtMs) ?? 0));
	const record = usable[0];
	if (!record) return [];
	const limits: Array<PlanLimit & { order: number }> = [];
	for (const m of record.meters as unknown[]) {
		if (!isObj(m) || m.status === "unavailable" || m.unit === "credits") continue;
		const category = isObj(m.details) ? m.details.limitCategory : undefined;
		if (category !== undefined && category !== "usage_limit" && category !== "rate_limit") continue;
		// A limit of one model counts only while the session uses it.
		const modelId = typeof m.modelId === "string" ? m.modelId : undefined;
		if (modelId ? !model?.includes(modelId) : m.scope === "model" || m.limitScope === "model") continue;
		let pct = usedPct(m);
		if (pct === undefined) continue;
		const resetAt = num(m.resetAtMs) ?? num(m.resetsAt);
		if (resetAt !== undefined && resetAt <= now) pct = 0;
		const { short, order } = windowName(m);
		limits.push({
			short,
			order,
			label: String(m.label ?? m.meterId),
			usedPct: Math.max(0, Math.min(100, pct)),
			resetAt: resetAt !== undefined && resetAt > now ? resetAt : undefined,
			reportedAt: num(record.fetchedAtMs),
		});
	}
	return limits.sort((a, b) => a.order - b.order).map(({ order: _, ...limit }) => limit);
}
