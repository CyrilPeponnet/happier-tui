import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	fuzzyFilter,
	type SlashCommand,
} from "@earendil-works/pi-tui";

const MAX_ITEMS = 30;

/** Every file and the directories that contain them, directories ending in "/". */
export function withDirectories(files: string[]): string[] {
	const dirs = new Set<string>();
	for (const f of files) {
		for (let i = f.indexOf("/"); i >= 0; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i + 1));
	}
	return [...dirs, ...files];
}

/** The `@query` token right before the cursor, if any. */
export function atToken(textBeforeCursor: string): string | null {
	const m = /(?:^|[\s(])(@[^\s"]*)$/.exec(textBeforeCursor);
	return m ? m[1]! : null;
}

/**
 * Slash commands, plus `@path` mentions completed against the session's files — which live on the
 * session's machine, not here. Local path completion is deliberately absent for the same reason.
 */
export class SessionAutocomplete implements AutocompleteProvider {
	private readonly commands: CombinedAutocompleteProvider;

	constructor(
		commands: SlashCommand[],
		/** Paths relative to the session directory; resolves empty when unavailable. */
		private readonly files: () => Promise<string[]>,
	) {
		this.commands = new CombinedAutocompleteProvider(commands, "/nonexistent");
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const token = atToken(before);
		if (token) {
			const paths = withDirectories(await this.files());
			const query = token.slice(1);
			const matches = query ? fuzzyFilter(paths, query, (p) => p) : paths.filter((p) => !p.slice(0, -1).includes("/"));
			if (options.signal.aborted || matches.length === 0) return null;
			const items: AutocompleteItem[] = matches.slice(0, MAX_ITEMS).map((p) => ({ value: `@${p}`, label: p }));
			return { items, prefix: token };
		}
		if (!before.trimStart().startsWith("/")) return null;
		return this.commands.getSuggestions(lines, cursorLine, cursorCol, options);
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		return this.commands.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}
