-- 18.11.2026: кабинеты «Haval+Tank» воркер fb-leads-haval отдаёт двумя строками в день (марка — по названию кампании:
-- Haval / Tank / «Не определена»), поэтому ключ таблицы — день × кабинет × марка. Таблица пересоздаётся с переносом строк.
CREATE TABLE haval_spend_new (
  date TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT,
  dealership TEXT,
  mark TEXT NOT NULL DEFAULT '',       -- Haval | Tank | Не определена | '' (кабинета нет в справочнике воркера)
  currency TEXT,
  spend REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  meta_leads INTEGER NOT NULL DEFAULT 0,
  loaded TEXT NOT NULL,
  PRIMARY KEY (date, account_id, mark)
);
INSERT INTO haval_spend_new (date, account_id, account_name, dealership, mark, currency, spend, impressions, clicks, meta_leads, loaded)
  SELECT date, account_id, account_name, dealership, COALESCE(mark, ''), currency, spend, impressions, clicks, meta_leads, loaded FROM haval_spend;
DROP TABLE haval_spend;
ALTER TABLE haval_spend_new RENAME TO haval_spend;
CREATE INDEX IF NOT EXISTS haval_spend_dealer ON haval_spend (dealership, date);
