-- Какие месяцы уже перенесены и сверены 1:1 (продолжение переноса после сбоя без повторной работы).
CREATE TABLE IF NOT EXISTS migration_done (
  tbl TEXT NOT NULL,
  month TEXT NOT NULL,
  rows INTEGER,
  spend_kzt REAL,
  run_id TEXT,
  finished TEXT,
  PRIMARY KEY (tbl, month)
);
