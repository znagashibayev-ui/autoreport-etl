-- 09.11.2026: итог каждого действия в админке (плашка внизу) и медиапланы (листы месяцев «Ноябрь 2026» …) с правками бюджета.

-- Действие = запуск задания с сайта. Итог (что сделано / почему не сработало и как исправить) хранится,
-- пока то же действие не сработает (resolved_at), — тогда предупреждение снимается.
CREATE TABLE IF NOT EXISTS cc_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,          -- задание (restore.yml …)
  inputs TEXT NOT NULL,        -- JSON параметров
  akey TEXT NOT NULL,          -- file + параметры: одно и то же действие
  label TEXT NOT NULL,         -- что запущено, по-русски
  at TEXT NOT NULL,
  who TEXT,
  run_id TEXT,                 -- запуск GitHub
  run_url TEXT,
  status TEXT NOT NULL,        -- running | ok | failed
  message TEXT,                -- что произошло
  problems TEXT,               -- JSON [{dealer, error, what, why, fix}]
  finished TEXT,
  resolved_at TEXT,            -- предупреждение снято (то же действие сработало позже)
  seen INTEGER NOT NULL DEFAULT 0 -- успех закрыт пользователем
);
CREATE INDEX IF NOT EXISTS actions_open ON cc_actions (resolved_at, status);

-- Лист месяца медиаплана (читает etl/gaps.mjs вместе с Ads Data). Одна строка на дилер × месяц.
CREATE TABLE IF NOT EXISTS cc_mp_sheets (
  dealer TEXT NOT NULL,
  month TEXT NOT NULL,
  ss TEXT NOT NULL,            -- ID таблицы медиаплана
  sheet TEXT NOT NULL,         -- «Ноябрь 2026»
  meta TEXT,                   -- JSON: бюджет, курс, дни, комиссии площадок, строки площадок
  rows TEXT,                   -- JSON: кампании (план и факт) со строками листа
  ads TEXT,                    -- JSON: кампании Ads Data за месяц
  error TEXT,
  checked TEXT NOT NULL,
  PRIMARY KEY (dealer, month)
);

-- Правки медиаплана с сайта: очередь для etl/mp_apply.mjs (пишет в таблицу сервисный аккаунт).
CREATE TABLE IF NOT EXISTS cc_mp_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer TEXT NOT NULL,
  month TEXT NOT NULL,
  ss TEXT NOT NULL,
  sheet TEXT NOT NULL,
  ops TEXT NOT NULL,           -- JSON [{row, col, value, expect}] — expect: что должно стоять в C этой строки (проверка, что лист не сдвинулся)
  summary TEXT NOT NULL,
  at TEXT NOT NULL,
  who TEXT,
  status TEXT NOT NULL,        -- pending | done | failed
  message TEXT,
  done_at TEXT
);
