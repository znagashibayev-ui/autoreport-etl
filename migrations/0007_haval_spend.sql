-- Расход рекламы Haval / Tank по дням (06.11.2026). Источник — Worker fb-leads-haval (/report), Meta, кабинеты в USD.
-- Грузит etl/haval_spend.mjs (задание «Расход Haval/Tank»): окно 28 дней каждый день ЗАМЕНЯЕТСЯ целиком
-- (Meta пересчитывает цифры задним числом до 28 дней). Одна строка = день × кабинет.
CREATE TABLE IF NOT EXISTS haval_spend (
  date TEXT NOT NULL,                  -- YYYY-MM-DD, часовой пояс кабинета
  account_id TEXT NOT NULL,
  account_name TEXT,
  dealership TEXT,                     -- дилер как в CRM; пусто — кабинета нет в справочнике воркера
  mark TEXT,                           -- Haval | Tank | Haval+Tank
  currency TEXT,
  spend REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  meta_leads INTEGER NOT NULL DEFAULT 0,
  loaded TEXT NOT NULL,                -- когда строка записана (UTC ISO)
  PRIMARY KEY (date, account_id)
);
CREATE INDEX IF NOT EXISTS haval_spend_dealer ON haval_spend (dealership, date);
