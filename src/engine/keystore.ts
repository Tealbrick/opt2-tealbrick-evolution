// The key ring of the payload codec (C371): kept in the SDK secret store, which seals it under TB_KEK (excluded from export,
// sealed inside backups). The key NEVER goes to the Temporal service: not in its env, its image, its volume or its backup.
//
//   engine-payload-keys = JSON { current: <kid>, keys: { <kid>: <base64 of 32 bytes>, ... } }
//
// First start: one key is generated. Rotation (rotateKey): a new key becomes `current`; the old ones stay in the ring so history
// sealed with them still opens; retireKey drops an old one after the Temporal retention window (14 days) has passed.
// Loss of the ring: see ARCHITECTURE.md ("Key loss costs run progress only").
import { randomBytes } from "node:crypto";
import { type KeyRing, keyIdOf } from "./codec.ts";

export const SECRET_NAME = "engine-payload-keys";

/** The part of the SDK's AppSecrets that the key store uses. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
}

interface Stored {
  current: string;
  keys: Record<string, string>;
}

const toRing = (s: Stored): KeyRing => ({ current: s.current, keys: Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, Buffer.from(v, "base64")])) });
const fromRing = (r: KeyRing): Stored => ({ current: r.current, keys: Object.fromEntries(Object.entries(r.keys).map(([k, v]) => [k, v.toString("base64")])) });

function parse(raw: string): Stored | null {
  try {
    const s = JSON.parse(raw) as Stored;
    if (typeof s.current !== "string" || !s.keys || typeof s.keys !== "object" || !s.keys[s.current]) return null;
    for (const v of Object.values(s.keys)) if (typeof v !== "string" || Buffer.from(v, "base64").length !== 32) return null;
    return s;
  } catch {
    return null;
  }
}

async function save(secrets: SecretStore, ring: KeyRing): Promise<void> {
  await secrets.put(SECRET_NAME, JSON.stringify(fromRing(ring)));
}

/** Loads the ring, or makes the first key. A stored value that is not a ring is NOT replaced (that would make old history unreadable): it throws. */
export async function loadKeyRing(secrets: SecretStore): Promise<KeyRing> {
  const raw = await secrets.get(SECRET_NAME);
  if (raw === null) {
    const key = randomBytes(32);
    const ring: KeyRing = { current: keyIdOf(key), keys: { [keyIdOf(key)]: key } };
    await save(secrets, ring);
    return ring;
  }
  const s = parse(raw);
  if (!s) throw new Error(`The stored ${SECRET_NAME} is not a valid key ring; it was not replaced.`);
  return toRing(s);
}

/** A new key becomes `current`; the older keys stay so existing history still opens. Mutates and returns the same ring object. */
export async function rotateKey(secrets: SecretStore, ring: KeyRing): Promise<KeyRing> {
  const key = randomBytes(32);
  const kid = keyIdOf(key);
  ring.keys[kid] = key;
  ring.current = kid;
  await save(secrets, ring);
  return ring;
}

/** Drops an old key (never the current one). Payloads still sealed with it become unreadable: their runs fail. */
export async function retireKey(secrets: SecretStore, ring: KeyRing, kid: string): Promise<KeyRing> {
  if (kid === ring.current) throw new Error("The current key cannot be retired; rotate first.");
  delete ring.keys[kid];
  await save(secrets, ring);
  return ring;
}
