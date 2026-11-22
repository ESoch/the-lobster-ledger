-- MCP credentials are independent of browser sessions and CLI credentials.
CREATE TABLE mcp_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
  created_at INTEGER NOT NULL
);
CREATE TABLE mcp_authorization_requests (
  request_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  csrf_hash TEXT
);
CREATE INDEX mcp_requests_expiry ON mcp_authorization_requests(expires_at);
CREATE TABLE mcp_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  session_id TEXT
);
CREATE INDEX mcp_codes_expiry ON mcp_authorization_codes(expires_at);
CREATE TABLE mcp_sessions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  access_scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  hard_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX mcp_sessions_member ON mcp_sessions(member_id);
CREATE TABLE mcp_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES mcp_sessions(id) ON DELETE CASCADE,
  used_at INTEGER,
  replacement_hash TEXT
);
