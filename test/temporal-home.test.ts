// C373 DEV: tb-exec drops root but HOME stays /root, so the Temporal CLI could not read its env file and exited.
// run.sh must export a writable HOME before the first `temporal` command.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

for (const script of ["run.sh", "temporal-restore"]) {
  test(`services/temporal/${script} exports a writable HOME before any temporal command`, () => {
    const sh = readFileSync(new URL(`../services/temporal/${script}`, import.meta.url), "utf8");
    const home = sh.search(/^export HOME=\$\{TEMPORAL_HOME:-\/tmp\/temporal-home\}$/m);
    const first = sh.search(/^\s*(until )?temporal /m);
    assert.ok(home >= 0, `${script} exports HOME`);
    assert.ok(first > home, "HOME is set before the first temporal command");
    assert.match(sh, /mkdir -p "\$HOME"/);
  });
}
