// Test doubles for the shell scripts of services/temporal: a subset of the `sqlite3` shell (what the scripts call) and of
// `sha256sum`, written on node:sqlite / node:crypto so the tests run where the real tools are missing (the CI node image has
// no sqlite3). The real tools are exercised by smoke/engine-smoke.ts against the built image.
//   node tools.ts sqlite3 [-batch] [-readonly] <file> <command>...     commands: SQL, .timeout N, .backup 'path'
//   node tools.ts sha256sum                                              stdin -> "<hex>  -"
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";

const [tool, ...args] = process.argv.slice(2);

if (tool === "sha256sum") {
  process.stdout.write(`${createHash("sha256").update(readFileSync(0)).digest("hex")}  -\n`);
} else if (tool === "sqlite3") {
  const rest = args.filter((a) => a !== "-batch");
  const readOnly = rest.includes("-readonly");
  const [file, ...commands] = rest.filter((a) => a !== "-readonly");
  if (!file) throw new Error("sqlite3 shim: no file");
  const db = new DatabaseSync(file, { readOnly });
  try {
    for (const cmd of commands) {
      if (cmd.startsWith(".timeout")) continue;
      if (cmd.startsWith(".backup")) {
        const target = /^\.backup\s+'(.*)'$/.exec(cmd)?.[1];
        if (!target) throw new Error(`sqlite3 shim: ${cmd}`);
        await backup(db, target);
        continue;
      }
      const sql = cmd.replace(/;\s*$/, "");
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
        for (const r of db.prepare(sql).all()) console.log(Object.values(r).join("|"));
      } else db.exec(cmd);
    }
  } finally {
    db.close();
  }
} else {
  throw new Error(`unknown tool ${tool}`);
}
