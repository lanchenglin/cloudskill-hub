-- Additive authentication migration. Existing API tokens, uploads and skills remain valid.
-- A publisher is stored as role=client + can_publish=1 to preserve existing CHECK/FKs.
ALTER TABLE access_tokens ADD COLUMN can_publish INTEGER NOT NULL DEFAULT 0 CHECK(can_publish IN (0,1));
ALTER TABLE access_tokens ADD COLUMN credential_type TEXT NOT NULL DEFAULT 'api' CHECK(credential_type IN ('api','web'));
ALTER TABLE access_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE access_tokens ADD COLUMN last_used_at TEXT;

CREATE TABLE web_admin (
 id INTEGER PRIMARY KEY CHECK(id=1),
 username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 password_version INTEGER NOT NULL DEFAULT 1,
 token_id TEXT NOT NULL UNIQUE REFERENCES access_tokens(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE web_sessions (
 session_hash TEXT PRIMARY KEY,
 admin_id INTEGER NOT NULL REFERENCES web_admin(id),
 password_version INTEGER NOT NULL,
 csrf_token TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 last_seen_at INTEGER NOT NULL,
 reauthenticated_at INTEGER NOT NULL
);
CREATE INDEX idx_web_sessions_expiry ON web_sessions(expires_at);
CREATE TABLE auth_rate_limits (
 key TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL,
 reset_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_rate_expiry ON auth_rate_limits(reset_at);
-- Recovery via trusted D1 administration also invalidates existing browser sessions.
CREATE TRIGGER invalidate_web_sessions_on_password_change
AFTER UPDATE OF password_hash ON web_admin
BEGIN
 DELETE FROM web_sessions WHERE admin_id=NEW.id;
END;
