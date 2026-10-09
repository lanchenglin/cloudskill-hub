-- Additive migration: old JSON artifacts and archives remain valid.
ALTER TABLE skill_versions ADD COLUMN artifact_format INTEGER NOT NULL DEFAULT 1;
ALTER TABLE skill_versions ADD COLUMN raw_bytes INTEGER;
ALTER TABLE skill_versions ADD COLUMN description TEXT;
CREATE TABLE upload_sessions (
 id TEXT PRIMARY KEY,
 token_id TEXT NOT NULL REFERENCES access_tokens(id),
 project_slug TEXT NOT NULL REFERENCES projects(slug),
 skill_slug TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('created','uploading','ready','committed','cancelled','deleting')),
 manifest TEXT NOT NULL,
 metadata TEXT,
 visibility TEXT NOT NULL CHECK(visibility IN ('private','public')),
 base_version INTEGER NOT NULL,
 result TEXT,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX idx_upload_expiry ON upload_sessions(state,expires_at);
CREATE INDEX idx_upload_owner ON upload_sessions(token_id,created_at);
