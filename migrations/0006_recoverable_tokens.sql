-- Add an encrypted display copy. Authentication still uses the existing token_hash.
-- Historical hash-only records remain NULL; never rotate, revoke or elevate them here.
ALTER TABLE access_tokens ADD COLUMN token_ciphertext TEXT;
