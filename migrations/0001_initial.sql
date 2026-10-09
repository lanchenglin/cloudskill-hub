PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS access_tokens (
 id TEXT PRIMARY KEY,
 label TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK (role IN ('admin', 'client')),
 project_scope TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL,
 revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
 slug TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
 project_slug TEXT NOT NULL REFERENCES projects(slug),
 slug TEXT NOT NULL,
 description TEXT NOT NULL,
 latest_version INTEGER NOT NULL DEFAULT 0,
 visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (project_slug, slug)
);
CREATE TABLE IF NOT EXISTS skill_versions (
 project_slug TEXT NOT NULL,
 slug TEXT NOT NULL,
 version INTEGER NOT NULL,
 artifact_digest TEXT NOT NULL,
 archive_digest TEXT NOT NULL,
 artifact_key TEXT NOT NULL,
 archive_key TEXT NOT NULL,
 file_names TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY (project_slug,slug,version),
 FOREIGN KEY (project_slug,slug) REFERENCES skills(project_slug,slug)
);
CREATE TABLE IF NOT EXISTS devices (
 token_id TEXT NOT NULL REFERENCES access_tokens(id),
 device_id TEXT NOT NULL,
 device_name TEXT NOT NULL,
 os TEXT NOT NULL,
 agents TEXT NOT NULL,
 installs TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 PRIMARY KEY (token_id,device_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
 id TEXT PRIMARY KEY,
 actor TEXT NOT NULL,
 action TEXT NOT NULL,
 detail TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_public_skill_slug ON skills(slug) WHERE visibility='public';
CREATE INDEX IF NOT EXISTS idx_skills_updated ON skills(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
