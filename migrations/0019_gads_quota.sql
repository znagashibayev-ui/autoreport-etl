-- Лимит Google Ads API (24.11.2026). Один developer token на все системы — 15 000 операций в сутки.
-- gads_hourly: запросы к googleads.googleapis.com по часам из Google Cloud Monitoring (OAuth-клиент общий для всех систем,
--   поэтому видны и Apps Script, и Worker'ы, и GitHub). Пишет etl/gads_usage.mjs (задание gads-usage.yml).
CREATE TABLE IF NOT EXISTS gads_hourly (
  hour TEXT NOT NULL,     -- начало часа, ISO UTC
  method TEXT NOT NULL,   -- google.ads.googleads.v24.services.GoogleAdsService.Search …
  code TEXT NOT NULL,     -- HTTP-код ответа: 200, 429 …
  n INTEGER NOT NULL,
  PRIMARY KEY (hour, method, code)
);
-- gads_exhausted: Hub упёрся в дневной лимит. Сайт после reset_at сам запускает Hub (daily) и ставит handled_at.
CREATE TABLE IF NOT EXISTS gads_exhausted (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,        -- когда случилось (ISO)
  source TEXT NOT NULL,    -- 'hub'
  mode TEXT,               -- режим запуска Hub
  reset_at TEXT NOT NULL,  -- когда лимит обновится: по retryDelay из ответа Google, иначе ближайшая полночь по Тихоокеанскому времени
  detail TEXT,
  handled_at TEXT
);
