-- 11.11.2026: мгновенное отслеживание правок медиапланов. Google Drive сообщает сайту (/hook/drive) о правке таблицы,
-- сайт запускает лёгкое задание mp-watch.yml (снимок листа → журнал cc_mp_log).
-- cc_mp_watch — подписки Google Drive (канал на таблицу медиаплана, живёт сутки; продлевает mp-watch-register.yml).
-- cc_mp_hits — последнее уведомление и запуск по таблице: не чаще одного запуска в 90 с, остальное догоняет сам запуск.
CREATE TABLE IF NOT EXISTS cc_mp_watch (
  id TEXT PRIMARY KEY,       -- id канала
  resource_id TEXT,          -- id ресурса Google (нужен для остановки канала)
  ss TEXT NOT NULL,          -- таблица медиаплана
  token TEXT NOT NULL,       -- секрет канала: Google присылает его в каждом уведомлении
  expires TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cc_mp_watch_ss ON cc_mp_watch (ss, expires);

CREATE TABLE IF NOT EXISTS cc_mp_hits (
  ss TEXT PRIMARY KEY,
  notified TEXT,             -- последнее уведомление Google
  dispatched TEXT,           -- последний запуск проверки
  pending INTEGER NOT NULL DEFAULT 0,
  n INTEGER NOT NULL DEFAULT 0
);
