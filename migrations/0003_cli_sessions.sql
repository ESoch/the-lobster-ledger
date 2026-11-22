CREATE TABLE cli_authorization_codes (code_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, device_name TEXT NOT NULL, expires_at INTEGER NOT NULL, redeemed_at INTEGER, session_id TEXT);
CREATE INDEX cli_codes_expiry ON cli_authorization_codes(expires_at);
CREATE TABLE cli_sessions (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), device_name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, access_hash TEXT NOT NULL UNIQUE, access_expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL, hard_expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX cli_sessions_member ON cli_sessions(member_id, revoked_at);
CREATE INDEX cli_sessions_expiry ON cli_sessions(hard_expires_at);
CREATE TABLE cli_refresh_tokens (token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES cli_sessions(id) ON DELETE CASCADE, used_at INTEGER, replacement_hash TEXT);
CREATE INDEX cli_refresh_session ON cli_refresh_tokens(session_id);
CREATE TABLE cli_bet_requests (member_id TEXT NOT NULL REFERENCES members(id), request_key TEXT NOT NULL, request_hash TEXT NOT NULL, request_nonce TEXT NOT NULL UNIQUE, response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at TEXT NOT NULL, PRIMARY KEY(member_id, request_key));
