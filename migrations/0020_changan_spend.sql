-- 27.11.2026: расход рекламы Changan по дням — Worker fb-leads-changan (/report), Meta, кабинеты в USD.
-- Грузит etl/haval_spend.mjs с BRAND=changan (задание «Расход Changan»): окно 28 дней каждый день заменяется целиком.
CREATE TABLE IF NOT EXISTS changan_spend (
  date TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT,
  dealership TEXT,
  mark TEXT NOT NULL DEFAULT '',
  currency TEXT,
  spend REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  meta_leads INTEGER NOT NULL DEFAULT 0,
  loaded TEXT NOT NULL,
  PRIMARY KEY (date, account_id, mark)
);
CREATE INDEX IF NOT EXISTS changan_spend_dealer ON changan_spend (dealership, date);
