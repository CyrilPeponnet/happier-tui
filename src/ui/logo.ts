import chalk from "chalk";

/**
 * A bunny: two ears with a notch between them, a rounded face, eyes and a smile. Pixels, drawn
 * two per character with half blocks.
 */
const PIXELS = [
	"....##....##....",
	"...####..####...",
	"...####..####...",
	"...####..####...",
	"...####..####...",
	"..############..",
	".##############.",
	".##############.",
	".###..####..###.",
	".###..####..###.",
	".##############.",
	".###.######.###.",
	".####......####.",
	".##############.",
	"..############..",
	"....########....",
];

/** Two soft tones, blended from the top left to the bottom right. */
const FROM: [number, number, number] = [187, 154, 247];
const TO: [number, number, number] = [122, 162, 247];

export const LOGO_WIDTH = PIXELS[0]!.length;
export const LOGO_HEIGHT = PIXELS.length / 2;

export function renderLogo(): string[] {
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
			const f = (x / LOGO_WIDTH + row / LOGO_HEIGHT) / 2;
			const [r, g, b] = FROM.map((v, k) => Math.round(v + (TO[k]! - v) * f)) as [number, number, number];
			line += chalk.rgb(r, g, b)(top && bottom ? "█" : top ? "▀" : "▄");
		}
		lines.push(line);
	}
	return lines;
}
