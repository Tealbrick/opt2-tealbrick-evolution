// Test helpers: a migrated node:sqlite database shaped like the SDK's Db, and fake handler contexts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Caller, CompanionResult, Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { manifest, migrationsDir } from "../src/app.ts";

export function migratedDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  // like the SDK's transaction runner: nested calls become savepoints
  let depth = 0;
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      const d = depth;
      raw.exec(d === 0 ? "BEGIN" : `SAVEPOINT sp${d}`);
      depth = d + 1;
      try {
        const v = fn();
        raw.exec(d === 0 ? "COMMIT" : `RELEASE sp${d}`);
        return v;
      } catch (e) {
        raw.exec(d === 0 ? "ROLLBACK" : `ROLLBACK TO sp${d}; RELEASE sp${d}`);
        throw e;
      } finally {
        depth = d;
      }
    },
  };
  return db as unknown as Db;
}

export const AGENT_A: Caller = { type: "agent", id: "agt_01J0000000000000000000000A" as Caller["id"], name: "Agent A", mode: "free" };
export const AGENT_B: Caller = { type: "agent", id: "agt_01J0000000000000000000000B" as Caller["id"], name: "Agent B", mode: "free" };
export const OWNER: Caller = { type: "person", id: "per_01J0000000000000000000000P" as Caller["id"], name: "owner", mode: null };

export type CallApp = (product: string, op: string, input: unknown, opts?: unknown) => Promise<CompanionResult>;

export function ctxFor(db: Db, caller: Caller, callApp?: CallApp): OpContext {
  const refuse: CallApp = async () => {
    throw new Error("no companion in this test");
  };
  return { db, caller, callApp: callApp ?? refuse } as unknown as OpContext;
}

/** Runs a handler from the app's handler map with a typed input, and checks the output against the manifest output
 *  schema as the SDK does (a handler answer the SDK would refuse fails the test). */
export async function call<O>(handlers: Record<string, { run: (i: never, c: OpContext) => Promise<unknown> } | unknown>, id: string, input: unknown, ctx: OpContext): Promise<O> {
  const h = handlers[id] as { run: (i: unknown, c: OpContext) => Promise<unknown> };
  const out = await h.run(input, ctx);
  const op = (manifest.operations as { id: string; output?: unknown }[]).find((o) => o.id === id);
  if (op?.output) {
    const v = validateAgainstSchema(op.output as never, JSON.parse(JSON.stringify(out)) as never);
    if (!v.ok) throw new Error(`${id} output fails the manifest schema: ${JSON.stringify(v.errors).slice(0, 400)}`);
  }
  return out as O;
}

/** an acting ticket as the bridge shapes it (header.payload.signature). This app reads only `sub` and `exp` (to file it); the bridge verifies it. */
export function ticketOf(agent: string, expSec: number = Math.floor(Date.now() / 1000) + 30 * 86400): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "EdDSA", typ: "tb-act+jwt" })}.${b64({ sub: `tb:agt:${agent}`, exp: expSec, job: "x" })}.sig`;
}
