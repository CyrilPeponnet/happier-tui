/**
 * Happier client-side crypto, reimplemented from the upstream sources:
 *   apps/cli/src/api/encryption.ts
 *   packages/protocol/src/crypto/{boxBundle,encryptedDataKeyEnvelopeV1,keyDerivation,serializedJsonValue}.ts
 *
 * Two content variants exist:
 *   legacy  : nonce(24) || secretbox(json)                      (XSalsa20-Poly1305)
 *   dataKey : 0x00 || nonce(12) || ciphertext || tag(16)         (AES-256-GCM)
 * A per-session/per-machine data key is wrapped as:
 *   0x00 || ephPub(32) || nonce(24) || box(key)                  (X25519 box)
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import nacl from "tweetnacl";

export type Variant = "legacy" | "dataKey";

/** Key material able to read and write one session's or machine's content. */
export type ContentKey = { variant: Variant; key: Uint8Array } | { variant: "plain" };

const SENTINEL = "__happierSerializedJsonValueV1";

export function stringifyValue(value: unknown): string {
	const envelope =
		value === undefined ? { [SENTINEL]: true, type: "undefined" } : { [SENTINEL]: true, type: "json", value };
	return JSON.stringify(envelope, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

export function parseValue(serialized: string): unknown {
	if (serialized === "undefined") return undefined;
	const parsed = JSON.parse(serialized) as unknown;
	if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)[SENTINEL] === true) {
		const env = parsed as { type?: string; value?: unknown };
		if (env.type === "undefined") return undefined;
		if (env.type === "json" && "value" in env) return env.value;
	}
	return parsed;
}

export const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
export const b64encode = (b: Uint8Array): string => Buffer.from(b).toString("base64");

function encryptLegacy(data: unknown, secret: Uint8Array): Uint8Array {
	const nonce = randomBytes(nacl.secretbox.nonceLength);
	const boxed = nacl.secretbox(new TextEncoder().encode(stringifyValue(data)), nonce, secret);
	const out = new Uint8Array(nonce.length + boxed.length);
	out.set(nonce);
	out.set(boxed, nonce.length);
	return out;
}

function decryptLegacy(bundle: Uint8Array, secret: Uint8Array): unknown {
	if (bundle.length < nacl.secretbox.nonceLength + nacl.secretbox.overheadLength) return null;
	const nonce = bundle.slice(0, nacl.secretbox.nonceLength);
	const opened = nacl.secretbox.open(bundle.slice(nacl.secretbox.nonceLength), nonce, secret);
	if (!opened) return null;
	return parseValue(new TextDecoder().decode(opened));
}

function encryptDataKey(data: unknown, key: Uint8Array): Uint8Array {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const body = Buffer.concat([cipher.update(stringifyValue(data), "utf8"), cipher.final()]);
	return new Uint8Array(Buffer.concat([Buffer.from([0]), nonce, body, cipher.getAuthTag()]));
}

function decryptDataKey(bundle: Uint8Array, key: Uint8Array): unknown {
	if (bundle.length < 1 + 12 + 16 || bundle[0] !== 0) return null;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, bundle.slice(1, 13));
		decipher.setAuthTag(bundle.slice(bundle.length - 16));
		const plain = Buffer.concat([decipher.update(bundle.slice(13, bundle.length - 16)), decipher.final()]);
		return parseValue(plain.toString("utf8"));
	} catch {
		return null;
	}
}

export function encryptBytes(ck: Exclude<ContentKey, { variant: "plain" }>, data: unknown): Uint8Array {
	return ck.variant === "legacy" ? encryptLegacy(data, ck.key) : encryptDataKey(data, ck.key);
}

/** Returns null when the bundle cannot be opened with this key. */
export function decryptBytes(ck: Exclude<ContentKey, { variant: "plain" }>, bundle: Uint8Array): unknown {
	return ck.variant === "legacy" ? decryptLegacy(bundle, ck.key) : decryptDataKey(bundle, ck.key);
}

// --- data-key wrapping ------------------------------------------------------

function tryOpenBox(bundle: Uint8Array, secretKey: Uint8Array): Uint8Array | null {
	if (bundle.length < 32 + 24 + nacl.box.overheadLength) return null;
	return nacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), secretKey);
}

/** Opens `0x00 || ephPub || nonce || box`. The key may be an X25519 secret key or its seed. */
export function openDataKeyEnvelope(envelope: Uint8Array, secretKeyOrSeed: Uint8Array): Uint8Array | null {
	if (envelope.length < 1 || envelope[0] !== 0) return null;
	const bundle = envelope.slice(1);
	return (
		tryOpenBox(bundle, secretKeyOrSeed) ??
		tryOpenBox(bundle, new Uint8Array(createHash("sha512").update(secretKeyOrSeed).digest()).slice(0, 32))
	);
}

// --- legacy account secret -> content key -----------------------------------

function hmac512(key: Uint8Array, data: Uint8Array): Uint8Array {
	return new Uint8Array(createHmac("sha512", key).update(data).digest());
}

/** BIP32-like HMAC-SHA512 tree (packages/protocol/src/crypto/keyDerivation.ts). */
function deriveKey(seed: Uint8Array, usage: string, path: string[]): Uint8Array {
	const enc = new TextEncoder();
	let I = hmac512(enc.encode(`${usage} Master Seed`), seed);
	for (const index of path) {
		const chain = I.slice(32);
		const data = new Uint8Array([0, ...enc.encode(index)]);
		I = hmac512(chain, data);
	}
	return I.slice(0, 32);
}

/** Account content X25519 secret key from a legacy recovery secret. */
export function machineKeyFromLegacySecret(secret: Uint8Array): Uint8Array {
	const seed = deriveKey(secret, "Happy EnCoder", ["content"]);
	return new Uint8Array(createHash("sha512").update(seed).digest()).slice(0, 32);
}

// --- account-scoped blobs ---------------------------------------------------

/** Kind bytes of account-scoped blobs (packages/protocol/src/crypto/accountScopedCipher.ts). */
const ACCOUNT_SCOPED_KINDS = { provider_account_usage_snapshot: 6 } as const;

/**
 * Opens an account-wide blob, such as a provider usage snapshot:
 * base64(0xA1 || kind || nonce(24) || secretbox(json)), keyed by
 * HMAC-SHA512(account machine key, "happier:account_scoped:<kind>:v1")[0..32].
 */
export function openAccountScoped(
	machineKey: Uint8Array,
	kind: keyof typeof ACCOUNT_SCOPED_KINDS,
	ciphertext: string,
): unknown | null {
	const bytes = b64decode(ciphertext);
	if (bytes.length < 2 + 24 + nacl.secretbox.overheadLength || bytes[0] !== 0xa1 || bytes[1] !== ACCOUNT_SCOPED_KINDS[kind]) return null;
	const key = hmac512(machineKey, new TextEncoder().encode(`happier:account_scoped:${kind}:v1`)).slice(0, 32);
	const opened = nacl.secretbox.open(bytes.slice(26), bytes.slice(2, 26), key);
	if (!opened) return null;
	try {
		return parseValue(new TextDecoder().decode(opened));
	} catch {
		return null;
	}
}
