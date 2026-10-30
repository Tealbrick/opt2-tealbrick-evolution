// Payload codec (C371, review F1 + F9): EVERY Temporal payload (workflow arguments, activity inputs and results, memo) is sealed
// with AES-256-GCM before it leaves the app, with a key only the app holds. Decode REFUSES a payload that is not sealed: a
// neighbour on the private network cannot read a history, cannot inject a forged step result (it cannot seal one), and the data of
// other apps stays sealed in the Temporal database and in its backups.
//
// Sealed payload = { metadata: { encoding: "binary/encrypted", "encryption-key-id": <kid> }, data: iv(12) || tag(16) || ciphertext }
// where the ciphertext covers the original payload (its metadata and data, as JSON). The kid binds the payload to its key: it is also
// the AAD of the GCM tag.
//
// Keys: a key ring {current, keys} (keystore.ts) in the SDK secret store (sealed under TB_KEK). Decode accepts every key of the
// ring, new writes use `current`: that is how a key is rotated (ARCHITECTURE.md).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Payload, PayloadCodec } from "@temporalio/common";

export const SEALED_ENCODING = "binary/encrypted";
export const KEY_ID_FIELD = "encryption-key-id";
const AAD_PREFIX = "tealbrick.evolution.payload/1:";

export class SealError extends Error {
  readonly code: "payload_not_sealed" | "payload_key_unknown" | "payload_corrupt" | "codec_locked";
  constructor(code: SealError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface KeyRing {
  /** the key id new payloads are sealed with */
  current: string;
  /** every key that may still open a payload: kid -> 32 bytes */
  keys: Record<string, Buffer>;
}

/** A short public name for a key (never the key). */
export const keyIdOf = (key: Buffer): string => createHash("sha256").update(key).digest("hex").slice(0, 12);

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const text = (u: Uint8Array | undefined | null): string => (u ? Buffer.from(u).toString("utf8") : "");

function seal(ring: KeyRing, p: Payload): Payload {
  const key = ring.keys[ring.current];
  if (!key) throw new SealError("codec_locked", "The current payload key is not in the ring.");
  const inner = JSON.stringify({ m: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, b64(v)])), d: p.data ? b64(p.data) : null });
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(AAD_PREFIX + ring.current));
  const ct = Buffer.concat([c.update(inner, "utf8"), c.final()]);
  return { metadata: { encoding: Buffer.from(SEALED_ENCODING), [KEY_ID_FIELD]: Buffer.from(ring.current) }, data: Buffer.concat([iv, c.getAuthTag(), ct]) };
}

function open(ring: KeyRing, p: Payload): Payload {
  if (text(p.metadata?.encoding) !== SEALED_ENCODING) throw new SealError("payload_not_sealed", "A payload that is not sealed was refused.");
  const kid = text(p.metadata?.[KEY_ID_FIELD]);
  const key = ring.keys[kid];
  if (!key) throw new SealError("payload_key_unknown", `A payload sealed with the key ${kid || "(none)"} was refused: the key is not in the ring.`);
  const d = p.data ? Buffer.from(p.data) : Buffer.alloc(0);
  if (d.length < 28) throw new SealError("payload_corrupt", "A sealed payload is too short.");
  try {
    const dec = createDecipheriv("aes-256-gcm", key, d.subarray(0, 12));
    dec.setAAD(Buffer.from(AAD_PREFIX + kid));
    dec.setAuthTag(d.subarray(12, 28));
    const inner = JSON.parse(Buffer.concat([dec.update(d.subarray(28)), dec.final()]).toString("utf8")) as { m: Record<string, string>; d: string | null };
    return { metadata: Object.fromEntries(Object.entries(inner.m).map(([k, v]) => [k, Buffer.from(v, "base64")])), data: inner.d === null ? null : Buffer.from(inner.d, "base64") };
  } catch {
    throw new SealError("payload_corrupt", "A sealed payload failed its check (wrong key or changed bytes).");
  }
}

/** The codec of the app: client, worker and the history reads of the run detail all use it. */
export function createSealCodec(getRing: () => KeyRing): PayloadCodec {
  return {
    async encode(payloads: Payload[]): Promise<Payload[]> {
      const ring = getRing();
      return payloads.map((p) => seal(ring, p));
    },
    async decode(payloads: Payload[]): Promise<Payload[]> {
      const ring = getRing();
      return payloads.map((p) => open(ring, p));
    },
  };
}

/** A codec that refuses everything: used while the key is not loaded, so nothing unsealed ever leaves or enters. */
export const lockedCodec: PayloadCodec = {
  async encode(): Promise<Payload[]> {
    throw new SealError("codec_locked", "The payload key is not loaded yet.");
  },
  async decode(): Promise<Payload[]> {
    throw new SealError("codec_locked", "The payload key is not loaded yet.");
  },
};
