import chalk from "chalk";

/** Pixels per side; rendered with half blocks, so SIZE columns by SIZE / 2 rows. */
export const LOGO_SIZE = 20;

/**
 * The Happier mark: a rounded square with a notch between two "ears" (reading as an H) and a
 * smile. Described geometrically from the app icon rather than stored as art, so it scales.
 */
function filled(x: number, y: number, n: number): boolean {
	const r = n * 0.2;
	const px = x + 0.5;
	const py = y + 0.5;
	const cx = Math.min(Math.max(px, r), n - r);
	const cy = Math.min(Math.max(py, r), n - r);
	if ((px - cx) ** 2 + (py - cy) ** 2 > r * r) return false;
	if (px > n * 0.36 && px < n * 0.64 && py < n * 0.33) return false;
	const t = (px - n / 2) / (n * 0.32);
	if (Math.abs(t) <= 1 && Math.abs(py - (n * 0.6 + n * 0.165 * (1 - t * t))) <= n * 0.042) return false;
	return true;
}

/** Colour stops of the sweep, looping back to the first. */
const STOPS: Array<[number, number, number]> = [
	[122, 162, 247],
	[187, 154, 247],
	[247, 118, 142],
	[255, 158, 100],
	[224, 175, 104],
	[158, 206, 106],
	[125, 207, 255],
];

function colorAt(phase: number): [number, number, number] {
	const p = (((phase % 1) + 1) % 1) * STOPS.length;
	const i = Math.floor(p);
	const a = STOPS[i % STOPS.length]!;
	const b = STOPS[(i + 1) % STOPS.length]!;
	const f = p - i;
	return [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * f)) as [number, number, number];
}

/** The mark with a diagonal colour gradient that drifts as `frame` advances. */
export function renderLogo(frame: number, size = LOGO_SIZE): string[] {
	const lines: string[] = [];
	for (let row = 0; row < size / 2; row++) {
		let line = "";
		for (let x = 0; x < size; x++) {
			const top = filled(x, row * 2, size);
			const bottom = filled(x, row * 2 + 1, size);
			if (!top && !bottom) {
				line += " ";
				continue;
			}
			const [r, g, b] = colorAt((x + row * 2) / (size * 2.2) - frame * 0.012);
			line += chalk.rgb(r, g, b)(top && bottom ? "█" : top ? "▀" : "▄");
		}
		lines.push(line);
	}
	return lines;
}
