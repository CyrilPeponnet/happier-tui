import assert from "node:assert/strict";
import { test } from "node:test";
import { Picker } from "../src/ui/picker.js";

test("a digit picks that item in a fixed menu, but filters in a searchable one", () => {
	const items = [
		{ value: "a", label: "1. A" },
		{ value: "b", label: "2. B" },
	];
	const picked: string[] = [];
	const fixed = new Picker({ title: "t", items, noFilter: true, onSelect: (i) => picked.push(i.value), onCancel: () => {} });
	fixed.handleInput("2");
	fixed.handleInput("9"); // out of range: nothing
	assert.deepEqual(picked, ["b"]);
	const searchable = new Picker({ title: "t", items, onSelect: (i) => picked.push(i.value), onCancel: () => {} });
	searchable.handleInput("1");
	assert.deepEqual(picked, ["b"]);
});
