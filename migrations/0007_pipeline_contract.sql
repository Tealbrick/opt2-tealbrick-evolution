-- C288 R10 (after 0.3.0 + R8): typed pipeline contract import / export. Forward only: TWO new tables; no existing table,
-- column or value changes, so 0.3.0 and R8 data upgrade unchanged (drafts, workflows and workflow_versions are not touched).
--
-- The contract (tealbrick.agents/pipeline-contract/0.1) is NOT part of the workflow snapshot: versions stay immutable
-- snapshots with their own diff, and every op that returns a snapshot (workflow_get, an AGENT op) keeps returning exactly
-- what it returned before. The imported contract lives beside the draft, and a copy is frozen per version at promotion.
-- `source` holds Martin's dictation refs, owners and purposes: read by person ops only (C88 / L12 posture), never by an
-- agent op. It is the contract object exactly as imported (validated first), so export can give back what came in.

-- One row per imported draft: the key (pipeline_id) and version of the contract, the contract itself, and the import
-- report shown to the owner (what mapped, what was not mapped, what is kept as data).
CREATE TABLE pipeline_sources (
  draft_id TEXT PRIMARY KEY REFERENCES drafts (id),
  pipeline_id TEXT NOT NULL CHECK (length(pipeline_id) BETWEEN 3 AND 41),
  pipeline_version INTEGER NOT NULL CHECK (typeof(pipeline_version) = 'integer' AND pipeline_version >= 1),
  source TEXT NOT NULL CHECK (json_valid(source) AND json_type(source) = 'object'),
  report TEXT NOT NULL CHECK (json_valid(report) AND json_type(report) = 'object'),
  imported_at INTEGER NOT NULL
);
CREATE INDEX pipeline_sources_by_pipeline ON pipeline_sources (pipeline_id);

-- The contract of the draft as it was when a version was promoted (copied by workflow_promote in the same transaction).
-- A version promoted from a draft that was never imported has no row.
CREATE TABLE workflow_version_pipelines (
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  pipeline_id TEXT NOT NULL CHECK (length(pipeline_id) BETWEEN 3 AND 41),
  pipeline_version INTEGER NOT NULL CHECK (typeof(pipeline_version) = 'integer' AND pipeline_version >= 1),
  source TEXT NOT NULL CHECK (json_valid(source) AND json_type(source) = 'object'),
  PRIMARY KEY (workflow_id, version),
  FOREIGN KEY (workflow_id, version) REFERENCES workflow_versions (workflow_id, version)
);
CREATE INDEX workflow_version_pipelines_by_pipeline ON workflow_version_pipelines (pipeline_id);
