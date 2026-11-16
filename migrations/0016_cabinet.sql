-- Сверка недолётов с реальными кабинетами (11.11.2026): эталон — итог, который выгрузка получила из API площадки
-- (те же правила конверсий, курсы и срез до Hub, что и при записи в D1), а не лист «Ads Data».
-- Пишет etl/run_platform.mjs при каждой выгрузке за месяц «с 1-го по вчера» (ночная, «Восстановить», дневная сверка без записи).
CREATE TABLE IF NOT EXISTS cc_cabinet (
  month TEXT NOT NULL,      -- YYYY-MM
  dealer TEXT NOT NULL,     -- Dealer_ID как в листе Total
  platform TEXT NOT NULL,   -- 'Google Ads' | 'Meta' | 'TikTok' | 'Yandex'
  date_to TEXT NOT NULL,    -- кабинет прочитан с 1-го числа по эту дату
  conv REAL, usd REAL, kzt REAL,
  camps TEXT,               -- JSON [{n, cv, usd, kzt}], n — кампания в нижнем регистре без _another
  at TEXT NOT NULL,         -- когда прочитан кабинет
  PRIMARY KEY (month, dealer, platform)
);

-- cc_gaps: ads_* теперь — числа кабинета; cab_at — когда кабинет прочитан; stale — кабинет прочитан не по вчерашний день
ALTER TABLE cc_gaps ADD COLUMN cab_at TEXT;
ALTER TABLE cc_gaps ADD COLUMN stale INTEGER;
