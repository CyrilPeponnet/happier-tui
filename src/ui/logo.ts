import chalk from "chalk";

/**
 * The Happier logo (a rounded square with a notch and a smile), sampled from Happier's own
 * `logo-white.png` at 10 × 10, with a shell prompt `›` cut in above the smile. Pixels, drawn two
 * per character with half blocks: five lines, as tall as the text beside it on the start screen.
 */
const PIXELS = [
	".##....##.",
	"####..####",
	"#.##..####",
	"##.#######",
	"#.########",
	"##########",
	"##.####.##",
	"###....###",
	"##########",
	".########.",
];

const FROM: [number, number, number] = [187, 154, 247];
const TO: [number, number, number] = [122, 162, 247];
const LIGHT: [number, number, number] = [235, 230, 255];

export const LOGO_WIDTH = PIXELS[0]!.length;
export const LOGO_HEIGHT = PIXELS.length / 2;

/** Idle, the two tones flow slowly across the logo; while connecting, a light band sweeps it. */
export type LogoMotion = "drift" | "shine";

const DRIFT_MS = 3000;
const SHINE_EVERY_MS = 1600;
const SHINE_CROSSING_MS = 900;

const mix = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * k)) as [number, number, number];

/** Colour at `d`, the position along the diagonal (0 top left, 1 bottom right), `ms` into the motion. */
function colourAt(motion: LogoMotion, d: number, ms: number): [number, number, number] {
	if (motion === "drift") return mix(FROM, TO, 0.5 + 0.5 * Math.sin(2 * Math.PI * (d - ms / DRIFT_MS)));
	const p = (ms % SHINE_EVERY_MS) / SHINE_CROSSING_MS;
	const band = p <= 1 ? Math.max(0, 1 - Math.abs(d - (p * 1.6 - 0.3)) / 0.18) : 0;
	return mix(mix(FROM, TO, d), LIGHT, band * 0.8);
}

export function renderLogo(motion: LogoMotion = "drift", ms = Date.now()): string[] {
	const on = (x: number, y: number) => PIXELS[y]?.[x] === "#";
	const lines: string[] = [];
	for (let row = 0; row < LOGO_HEIGHT; row++) {
		let line = "";
		for (let x = 0; x < LOGO_WIDTH; x++) {
			const top = on(x, row * 2);
			const bottom = on(x, row * 2 + 1);
			if (!top && !bottom) {
				line += " ";
				continue;
			}
			const [r, g, b] = colourAt(motion, (x / LOGO_WIDTH + row / LOGO_HEIGHT) / 2, ms);
			line += chalk.rgb(r, g, b)(top && bottom ? "█" : top ? "▀" : "▄");
		}
		lines.push(line);
	}
	return lines;
}
