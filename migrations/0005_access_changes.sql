-- Правка доступов из админки (04.11.2026). Сайт пишет сюда правку и сразу применяет её в D1
-- (cc_email_access и dealer_email_access — их читает новый дашборд), а задание «Синхронизация таблиц»
-- переносит правку в лист Email_Access таблицы All_Tokens (его читают старый дашборд и портал) и отмечает итог.
CREATE TABLE IF NOT EXISTS cc_access_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  email TEXT NOT NULL,
  dealer TEXT NOT NULL,
  action TEXT NOT NULL,                -- add | remove
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
  note TEXT,
  applied TEXT
);
CREATE INDEX IF NOT EXISTS cc_access_changes_status ON cc_access_changes (status);
