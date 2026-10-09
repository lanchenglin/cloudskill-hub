-- Existing accounts retain their password and activation state. New setup explicitly sets 1.
ALTER TABLE web_admin ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1));
-- Proof for known-default initial passwords; only its SHA-256 digest is retained.
ALTER TABLE web_admin ADD COLUMN activation_secret_hash TEXT CHECK(activation_secret_hash IS NULL OR length(activation_secret_hash)=64);
