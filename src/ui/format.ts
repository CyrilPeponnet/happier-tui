/** Small pure formatting helpers shared by the screens. */
import { type SelectItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Machine, PermissionRequest } from "../happier/client.js";
import { clean } from "./theme.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** `left` and `right` on one line of exactly `width` columns; `left` gives way first. */
export function justify(left: string, right: string, width: number): string {
	const rw = visibleWidth(right);
	const l = truncateToWidth(left, Math.max(0, width - rw - 1));
	const gap = Math.max(1, width - visibleWidth(l) - rw);
	return truncateToWidth(`${l}${" ".repeat(gap)}${right}`, width, "", true);
}

/** Host name without its domain. */
export function shortHost(host: unknown): string {
	return typeof host === "string" ? (host.split(".")[0] ?? host) : "";
}

export function machineName(m: Machine | undefined): string {
	if (!m) return "";
	const display = m.metadata.displayName;
	return typeof display === "string" && display ? display : shortHost(m.metadata.host) || m.id.slice(0, 8);
}

/** The one argument that best identifies a tool request (command, path, url…). */
export function requestSummary(req: PermissionRequest): string {
	const a = isObj(req.arguments) ? req.arguments : {};
	for (const key of ["command", "file_path", "path", "url", "pattern", "query", "description", "title"]) {
		const v = a[key];
		if (typeof v === "string" && v) return clean(v).replace(/\s+/g, " ").slice(0, 200);
	}
	return "";
}

/** Multiple-choice questions carried by an AskUserQuestion-style request. */
export function questionsOf(req: PermissionRequest): Array<{ question: string; options: SelectItem[] }> {
	const a = isObj(req.arguments) ? req.arguments : {};
	if (!Array.isArray(a.questions)) return [];
	const out: Array<{ question: string; options: SelectItem[] }> = [];
	for (const q of a.questions) {
		if (!isObj(q) || typeof q.question !== "string" || !Array.isArray(q.options)) continue;
		const options = q.options
			.filter((o): o is Obj => isObj(o) && typeof o.label === "string")
			.map((o) => ({
				value: String(o.label),
				label: clean(String(o.label)),
				description: typeof o.description === "string" ? clean(o.description) : undefined,
			}));
		if (options.length) out.push({ question: clean(q.question), options });
	}
	return out;
}

/** A future time as "14:30 (in 2h 5m)", "Thu 16:00 (in 3d 2h)" past a day, or "now" when it has passed. */
export function untilText(at: number, now = Date.now()): string {
	const minutes = Math.ceil((at - now) / 60_000);
	if (minutes <= 0) return "now";
	const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const hours = Math.floor(minutes / 60);
	const span = (n: number, unit: string, rest: number, restUnit: string) => `${n}${unit}${rest ? ` ${rest}${restUnit}` : ""}`;
	if (hours < 24) return `${time} (in ${hours ? span(hours, "h", minutes % 60, "m") : `${minutes}m`})`;
	const day = new Date(at).toLocaleDateString([], { weekday: "short" });
	return `${day} ${time} (in ${span(Math.floor(hours / 24), "d", hours % 24, "h")})`;
}
