-- 10.11.2026: текущие дневные бюджеты кампаний из рекламных кабинетов (etl/budgets.mjs, шаг задания «Пересчёт недолётов»).
-- Раздел «Медиапланы» подставляет их в «Новая кампания». Строка с campaign = '' — ошибка чтения кабинета (note).
CREATE TABLE IF NOT EXISTS cc_budgets (
  dealer TEXT NOT NULL,
  platform TEXT NOT NULL,      -- Meta | Google Ads | TikTok | Yandex
  account TEXT NOT NULL,       -- ID кабинета / логин Яндекса
  campaign TEXT NOT NULL,      -- имя кампании как в кабинете
  status TEXT,                 -- ACTIVE | PAUSED | …
  daily REAL,                  -- дневной бюджет в валюте кабинета (для групп — сумма, для Яндекса с недельным лимитом — лимит / 7)
  total REAL,                  -- бюджет на весь срок, если дневного нет
  currency TEXT,
  mode TEXT,                   -- day | adsets | weekly | total | none | error
  note TEXT,
  checked TEXT NOT NULL,
  PRIMARY KEY (dealer, platform, account, campaign)
);
CREATE INDEX IF NOT EXISTS budgets_dealer ON cc_budgets (dealer);
