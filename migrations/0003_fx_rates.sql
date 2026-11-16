-- Курсы валют задаёт владелец на сайте (04.11.2026). Курс Нацбанка больше не используется.
-- Логика выбора курса — etl/lib/fx.mjs (общая для ETL и сайта).

-- Курс за месяц. Уровни: Platform = '' и Dealer_ID = '' — вся сеть; только Platform — площадка;
-- Platform + Dealer_ID — один аккаунт. Пустое поле (NULL) = берётся с уровня выше.
CREATE TABLE IF NOT EXISTS fx_rates (
  month TEXT NOT NULL,                 -- YYYY-MM
  Platform TEXT NOT NULL DEFAULT '',
  Dealer_ID TEXT NOT NULL DEFAULT '',
  usd REAL,                            -- 1 USD в тенге
  eur REAL,                            -- 1 EUR в тенге
  updated TEXT,
  PRIMARY KEY (month, Platform, Dealer_ID)
);

-- Валюта кабинета: Dealer_ID = '' — по умолчанию для площадки.
CREATE TABLE IF NOT EXISTS fx_account_currency (
  Platform TEXT NOT NULL,
  Dealer_ID TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,              -- KZT | USD | EUR
  updated TEXT,
  PRIMARY KEY (Platform, Dealer_ID)
);

-- Журнал изменений курсов и пересчётов.
CREATE TABLE IF NOT EXISTS fx_log (
  at TEXT NOT NULL,
  action TEXT NOT NULL,                -- rate | currency | recalc
  month TEXT,
  detail TEXT                          -- JSON
);
CREATE INDEX IF NOT EXISTS fx_log_at ON fx_log (at);

-- Стартовые значения — как в Apps Script (FIXED_RATES_BY_MONTH, ACCOUNT_CURRENCY_*). Октябрь и ноябрь не заданы.
INSERT OR IGNORE INTO fx_rates (month, Platform, Dealer_ID, usd, eur, updated) VALUES
  ('2026-01', '', '', 550, 600, '2026-11-04T00:00:00Z'),
  ('2026-02', '', '', 550, 600, '2026-11-04T00:00:00Z'),
  ('2026-03', '', '', 480, 600, '2026-11-04T00:00:00Z'),
  ('2026-04', '', '', 466.5, 600, '2026-11-04T00:00:00Z'),
  ('2026-05', '', '', 491, 564, '2026-11-04T00:00:00Z'),
  ('2026-06', '', '', 482, 600, '2026-11-04T00:00:00Z'),
  ('2026-07', '', '', 550, 600, '2026-11-04T00:00:00Z'),
  ('2026-08', '', '', 463, 600, '2026-11-04T00:00:00Z'),
  ('2026-09', '', '', 500, 600, '2026-11-04T00:00:00Z');

INSERT OR IGNORE INTO fx_account_currency (Platform, Dealer_ID, currency, updated) VALUES
  ('Google Ads', '', 'USD', '2026-11-04T00:00:00Z'),
  ('Meta', '', 'USD', '2026-11-04T00:00:00Z'),
  ('TikTok', '', 'USD', '2026-11-04T00:00:00Z'),
  ('Yandex', '', 'KZT', '2026-11-04T00:00:00Z'),
  ('Google Ads', 'Distributor_BMW', 'EUR', '2026-11-04T00:00:00Z');

-- Расход в валюте кабинета — из него точно пересчитываются Spend_KZT / Spend_USD при смене курса.
ALTER TABLE daily_statistics ADD COLUMN Spend_Native REAL;
ALTER TABLE daily_statistics ADD COLUMN Currency TEXT;

-- Натив для уже перенесённых строк (как legacyNativeSql в etl/lib/fx.mjs): обращаем пересчёт Apps Script.
UPDATE daily_statistics SET
  Currency = CASE
    WHEN Platform = 'Yandex' THEN 'KZT'
    WHEN Dealer_ID = 'Distributor_BMW' AND Platform = 'Google Ads' THEN 'EUR'
    ELSE 'USD' END,
  Spend_Native = CASE
    WHEN Platform = 'Yandex' THEN Spend_KZT
    WHEN Dealer_ID = 'Distributor_BMW' AND Platform = 'Google Ads' THEN Spend_USD * (CASE substr(Date, 1, 7)
      WHEN '2026-01' THEN 550.0 / 600 WHEN '2026-02' THEN 550.0 / 600 WHEN '2026-03' THEN 480.0 / 600
      WHEN '2026-04' THEN 466.5 / 600 WHEN '2026-05' THEN 491.0 / 564 WHEN '2026-06' THEN 482.0 / 600
      WHEN '2026-07' THEN 550.0 / 600 WHEN '2026-08' THEN 463.0 / 600 WHEN '2026-09' THEN 500.0 / 600
      ELSE 1 END)
    ELSE Spend_USD END
WHERE Spend_Native IS NULL;
