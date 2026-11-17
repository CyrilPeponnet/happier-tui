import assert from "node:assert/strict";
import { test } from "node:test";
import { atToken, SessionAutocomplete, withDirectories } from "../src/ui/autocomplete.js";

test("@ token before the cursor", () => {
	assert.equal(atToken("look at @src/ma"), "@src/ma");
	assert.equal(atToken("@"), "@");
	assert.equal(atToken("mail me@example"), null);
	assert.equal(atToken("no token"), null);
});

test("directories are offered along with files", () => {
	assert.deepEqual(withDirectories(["a/b/c.ts", "d.ts"]), ["a/", "a/b/", "a/b/c.ts", "d.ts"]);
});

test("@ completes against the session's files, / against commands, nothing else", async () => {
	const ac = new SessionAutocomplete([{ name: "model", description: "Change the model" }], async () => ["src/main.ts", "README.md"]);
	const signal = new AbortController().signal;
	const files = await ac.getSuggestions(["see @mai"], 0, 8, { signal });
	assert.equal(files?.prefix, "@mai");
	assert.equal(files?.items[0]?.value, "@src/main.ts");
	const top = await ac.getSuggestions(["@"], 0, 1, { signal });
	assert.deepEqual(top?.items.map((i) => i.label), ["src/", "README.md"]);
	const cmd = await ac.getSuggestions(["/mo"], 0, 3, { signal });
	assert.equal(cmd?.items[0]?.value, "model");
	assert.equal(await ac.getSuggestions(["src/ma"], 0, 6, { signal, force: true }), null);
});
