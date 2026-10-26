// The owner op of the move (C367 M3): `migration_status` for the badge and the summary on the Workflows page.
import type { HandlerSpec, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { OP } from "#kit";
import { countsOf, listItems, marker } from "./state.ts";

export function migrateHandlers() {
  return {
    [OP.migrationStatus]: {
      async run(_input: K.MigrationStatusInput, ctx: OpContext) {
        const items = listItems(ctx.db);
        const m = marker(ctx.db);
        return { done: m !== null, doneAt: m ? new Date(m.doneAt).toISOString() : null, counts: countsOf(items), items } satisfies K.MigrationStatusOutput;
      },
    } as unknown as HandlerSpec,
  };
}
