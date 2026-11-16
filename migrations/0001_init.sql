-- База D1 «autoreport» — замена marketing_data в BigQuery (этап 1 переезда, 03.11.2026).
-- Колонки daily_statistics повторяют BigQuery 1:1, чтобы сверка была прямой.

CREATE TABLE IF NOT EXISTS daily_statistics (
  Date TEXT NOT NULL,                -- YYYY-MM-DD
  Platform TEXT,
  Dealer_ID TEXT,
  Dealer_Type TEXT,
  Campaign_Name TEXT,
  Impressions INTEGER,
  Reach INTEGER,
  Clicks INTEGER,
  Conversions INTEGER,
  Spend_KZT REAL,
  Spend_USD REAL,
  Marketing_Objective TEXT,
  Campaign_Type TEXT,
  Car_Brand TEXT,
  Car_Model TEXT
);
CREATE INDEX IF NOT EXISTS ds_date ON daily_statistics (Date);
CREATE INDEX IF NOT EXISTS ds_dealer_platform_date ON daily_statistics (Dealer_ID, Platform, Date);

-- Кто какие отчёты видит (было: marketing_data.dealer_email_access).
CREATE TABLE IF NOT EXISTS dealer_email_access (
  Email TEXT NOT NULL,
  Distr_Dealer_ID TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dea_email ON dealer_email_access (Email);

-- Журнал запусков переноса и ETL.
CREATE TABLE IF NOT EXISTS etl_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- inventory | daily | segments | access | verify | etl:<platform>
  started TEXT NOT NULL,
  finished TEXT,
  status TEXT NOT NULL,              -- running | done | failed
  detail TEXT                        -- JSON
);

-- Результат сверки с BigQuery: одна строка на месяц × дилер × площадка × таблица.
CREATE TABLE IF NOT EXISTS migration_check (
  run_id TEXT NOT NULL,
  tbl TEXT NOT NULL,
  month TEXT NOT NULL,
  Dealer_ID TEXT,
  Platform TEXT,
  bq_rows INTEGER, new_rows INTEGER,
  bq_spend_kzt REAL, new_spend_kzt REAL,
  bq_conversions REAL, new_conversions REAL,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mc_run ON migration_check (run_id);
