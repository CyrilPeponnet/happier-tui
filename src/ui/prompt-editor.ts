import { Editor } from "@earendil-works/pi-tui";
import { c } from "./theme.js";

/** pi-tui marks the fake cursor with these; the placeholder goes right after it. */
const CURSOR_END = "\x1b_pi:/fc\x07";

/** The message editor, with a `›` prompt and a hint while it is empty. */
export class PromptEditor extends Editor {
	placeholder = "";

	override render(width: number): string[] {
		const lines = super.render(width);
		const first = lines[1];
		if (first === undefined || !first.startsWith(" ")) return lines;
		let line = c.accent("›") + first.slice(1);
		const at = line.indexOf(CURSOR_END);
		if (this.placeholder && this.getText() === "" && at >= 0) {
			const head = line.slice(0, at + CURSOR_END.length);
			const room = line.length - head.length; // the rest of an empty line is plain spaces
			const hint = this.placeholder.slice(0, Math.max(0, room - 1));
			line = head + c.faint(` ${hint}`) + " ".repeat(Math.max(0, room - hint.length - 1));
		}
		lines[1] = line;
		return lines;
	}
}
