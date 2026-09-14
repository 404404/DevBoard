export const REQUEST_IDEMPOTENCY_SQL = `
CREATE TABLE request_idempotency (
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (
    json_valid(response_json) AND json_type(response_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, scope, idempotency_key)
) STRICT;

CREATE INDEX request_idempotency_created_at_idx ON request_idempotency(created_at);
`;
