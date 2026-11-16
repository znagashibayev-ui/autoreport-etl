-- 11.11.2026: автовыравнивание плана «Общий бюджет» (S). Если доли кампаний площадки перестали давать 100% и S ушёл от утверждённого,
-- задание само раздаёт разницу кампаниям, которые руками не правили, и оставляет здесь уведомление: что, сколько и куда.
-- Уведомление висит в админке, пока владелец не нажмёт «Подтвердить».
CREATE TABLE IF NOT EXISTS cc_mp_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer TEXT NOT NULL,
  month TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,          -- autofix | autofix_failed
  detail TEXT NOT NULL,        -- JSON: [{p, before, after, base, locked: [имена], moves: [{name, fromS, toS, fromDaily, toDaily, fromShare, toShare}], reason}]
  confirmed_at TEXT,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS cc_mp_notices_open ON cc_mp_notices (dealer, month, confirmed_at);
