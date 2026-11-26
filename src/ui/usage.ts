import { untilText } from "./format.js";
import { c } from "./theme.js";

/** One gauge: the session's context, or a plan limit of the agent's provider account. */
export interface Meter {
	/** Footer name: "ctx", "5h", "wk". */
	short: string;
	/** Panel name: "Context", "5-hour limit". */
	label: string;
	usedPct: number;
	/** Panel detail, e.g. "46k of 200k tokens". */
	detail?: string;
	resetAt?: number;
}

/** The app's ring, at one character: empty, a quarter, half, three quarters, full. */
const RINGS = ["○", "◔", "◑", "◕", "●"];

const ring = (pct: number) => RINGS[Math.max(0, Math.min(4, Math.round(pct / 25)))]!;

/** Quiet until a meter needs attention: amber from 70%, red from 90%. */
export function meterTone(pct: number): (s: string) => string {
	return pct >= 90 ? c.err : pct >= 70 ? c.warn : c.dim;
}

/** Footer form: `◔ ctx  ◑ 5h  ● wk`. */
export function meterGlyphs(meters: Meter[]): string {
	return meters.map((m) => meterTone(m.usedPct)(`${ring(m.usedPct)} ${m.short}`)).join("  ");
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

function bar(pct: number, width: number): string {
	const filled = (Math.max(0, Math.min(100, pct)) / 100) * width;
	const full = Math.floor(filled);
	const part = full < width ? EIGHTHS[Math.round((filled - full) * 7)]! : "";
	return "█".repeat(full) + part + c.faint("░".repeat(width - full - (part ? 1 : 0)));
}

/** Panel form, one line per meter: name, bar, percent, detail and reset. */
export function meterRows(meters: Meter[], width: number, now = Date.now()): string[] {
	const name = Math.max(...meters.map((m) => m.label.length));
	const span = Math.max(10, Math.min(32, width - name - 40));
	return meters.map((m) => {
		const tone = meterTone(m.usedPct);
		const pct = `${Math.round(m.usedPct)}%`.padStart(4);
		const reset = m.resetAt ? `resets ${untilText(m.resetAt, now)}` : "";
		const detail = [m.detail, reset].filter(Boolean).join(" · ");
		return `${m.label.padEnd(name)}  ${tone(bar(m.usedPct, span))} ${tone(pct)}  ${c.dim(detail)}`;
	});
}
