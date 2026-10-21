-- Keep existing invitation hashes, limits, usage and references unchanged.
-- expires_at remains NOT NULL for compatibility with the existing D1 table.
-- An empty expires_at denotes no expiry; application responses expose it as null.
ALTER TABLE invitations ADD COLUMN token_ciphertext TEXT;
