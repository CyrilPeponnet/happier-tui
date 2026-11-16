import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import nacl from "tweetnacl";
import {
	decryptBytes,
	encryptBytes,
	machineKeyFromLegacySecret,
	openDataKeyEnvelope,
	parseValue,
	stringifyValue,
} from "../src/happier/crypto.js";

/** Wraps a data key the way a Happier client does: 0x00 || ephPub || nonce || box. */
function sealDataKeyEnvelope(dataKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
	const eph = nacl.box.keyPair();
	const nonce = new Uint8Array(randomBytes(nacl.box.nonceLength));
	const boxed = nacl.box(dataKey, nonce, recipientPublicKey, eph.secretKey);
	return new Uint8Array(Buffer.concat([Buffer.from([0]), eph.publicKey, nonce, boxed]));
}

const value = { role: "user", content: { type: "text", text: "héllo ✓" }, n: 1 };

test("dataKey variant round-trips and uses the documented layout", () => {
	const key = new Uint8Array(randomBytes(32));
	const bundle = encryptBytes({ variant: "dataKey", key }, value);
	assert.equal(bundle[0], 0);
	const plainLength = Buffer.byteLength(stringifyValue(value));
	assert.equal(bundle.length, 1 + 12 + plainLength + 16);
	assert.deepEqual(decryptBytes({ variant: "dataKey", key }, bundle), value);
});

test("legacy variant round-trips", () => {
	const key = new Uint8Array(randomBytes(32));
	const bundle = encryptBytes({ variant: "legacy", key }, value);
	assert.deepEqual(decryptBytes({ variant: "legacy", key }, bundle), value);
});

test("wrong key or tampered bundle yields null instead of throwing", () => {
	const key = new Uint8Array(randomBytes(32));
	const other = new Uint8Array(randomBytes(32));
	for (const variant of ["dataKey", "legacy"] as const) {
		const bundle = encryptBytes({ variant, key }, value);
		assert.equal(decryptBytes({ variant, key: other }, bundle), null);
		bundle[bundle.length - 1]! ^= 1;
		assert.equal(decryptBytes({ variant, key }, bundle), null);
	}
	assert.equal(decryptBytes({ variant: "dataKey", key }, new Uint8Array([0, 1, 2])), null);
});

test("data key envelope opens with the recipient secret key, and with its seed", () => {
	const dataKey = new Uint8Array(randomBytes(32));
	const pair = nacl.box.keyPair();
	const envelope = sealDataKeyEnvelope(dataKey, pair.publicKey);
	assert.equal(envelope[0], 0);
	assert.deepEqual(openDataKeyEnvelope(envelope, pair.secretKey), dataKey);
	assert.equal(openDataKeyEnvelope(envelope, nacl.box.keyPair().secretKey), null);

	const seed = new Uint8Array(randomBytes(32));
	const derived = machineKeyFromLegacySecret(seed);
	assert.equal(derived.length, 32);
	assert.deepEqual(machineKeyFromLegacySecret(seed), derived);
});

test("serialized values accept bare JSON from older writers", () => {
	assert.deepEqual(parseValue('{"a":1}'), { a: 1 });
	assert.deepEqual(parseValue(stringifyValue({ a: 1 })), { a: 1 });
	assert.equal(parseValue(stringifyValue(undefined)), undefined);
});
