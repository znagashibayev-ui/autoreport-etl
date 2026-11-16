-- Недолёты (09.11.2026): сверка медиапланов (лист «Ads Data» Autoreport Hub) с D1 — то же, что страница «Недолетевшие конверсии»
-- в Apps Script (Gaps_WebApp.gs + Gaps_HubCap.gs), но считает GitHub (etl/gaps.mjs), а показывает админка.

-- Одна строка на месяц × дилер × площадка. Ошибка чтения медиаплана — строка с platform = '' и error.
CREATE TABLE IF NOT EXISTS cc_gaps (
  month TEXT NOT NULL,            -- YYYY-MM
  dealer TEXT NOT NULL,           -- Dealer_ID из Registry Hub
  title TEXT,                     -- бренд/название из Registry
  grp TEXT,                       -- группа (BMW, Hyundai, …) как mgGroup_
  platform TEXT NOT NULL,         -- 'Google Ads' | 'Meta' | 'TikTok' | 'Yandex' | ''
  ads_conv REAL,                  -- конверсии в Ads Data
  d1_conv REAL,                   -- конверсии в D1 по ту же дату
  gap INTEGER,                    -- > 0 недолетело, < 0 лишние в D1
  ads_spend REAL, d1_spend REAL, spend_cur TEXT, spend_ok INTEGER, -- spend_ok: 1 / 0 / NULL (площадки нет в Ads Data)
  no_hub INTEGER,                 -- площадки нет в Ads Data
  ads_date TEXT,                  -- последняя дата в Ads Data за месяц
  cap_date TEXT,                  -- сверено по эту дату
  camps TEXT,                     -- JSON: кампании с расхождением [{n,a,b,sa,sb,x}]
  error TEXT,
  checked TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gaps_month ON cc_gaps (month, dealer);

-- Что загружено в D1 прямо из кабинетов (GitHub): эти дилер × площадка × даты ежедневная копия из BigQuery не перезаписывает.
CREATE TABLE IF NOT EXISTS cc_restored (
  dealer TEXT NOT NULL,
  platform TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS restored_dp ON cc_restored (dealer, platform);
