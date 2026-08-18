CREATE TABLE IF NOT EXISTS projected_ops (
  user_id          TEXT NOT NULL,
  seq              TEXT NOT NULL,
  epoch            TEXT NOT NULL,
  operation_sha256 TEXT NOT NULL,
  body             TEXT NOT NULL,
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_projected_ops_user ON projected_ops (user_id);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  user_id     TEXT PRIMARY KEY,
  epoch       TEXT NOT NULL,
  through_seq TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
