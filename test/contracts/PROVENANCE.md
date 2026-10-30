# Provenance of the contract files in this folder

These files are byte copies. Do not edit them. To update, copy the files from a newer spec tag and change this header and
the sha256 table of `test/access-spec.test.ts` in the same commit. That test fails when a file no longer matches.

- Source repo: `Tealbrick/opt2-tealbrick-specs` (private)
- Source: PENDING the tag `spec-v0.1.89` (copied from branch `c380/b1-access-contract` at `d543905ab4d387339baae16ce71a75379ff7f637`)
- Contract: `tb.access/1` (docs/ACCESS.md): `access_list` and `access_revoke` (C380). Producer here: Evolving Workflows, kinds `routine`, `workflow_agent_step`, `schedule_of_workflow`.

| File here | Path in the source repo |
|---|---|
| `access.*.1.schema.json` (4) | `packages/spec/schemas/contracts/` |
| `access.*.1.json` (6, fixtures) | `packages/spec/examples/contracts/` |

How this app uses them: the manifest embeds the four schemas as the input and output of `access_list` and `access_revoke`
(`test/access-spec.test.ts` compares them). The valid and invalid fixtures run against those schemas; the caller vector runs
through `guardFleet`; the digest fixture runs through `itemDigest`.
