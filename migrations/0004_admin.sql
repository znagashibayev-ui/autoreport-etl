-- Админка без Apps Script (04.11.2026): копия листов таблицы All_Tokens и настройки-регуляторы.
-- Источник правды пока — сама таблица All_Tokens (её читают старый дашборд и портал); сюда её копирует
-- задание GitHub «Синхронизация таблиц» (etl/sync_sheets.mjs). Самих токенов здесь нет — только «есть / нет».

-- Дилер × площадка: лист Total + Token_Health.
CREATE TABLE IF NOT EXISTS cc_dealers (
  Dealer_ID TEXT NOT NULL,
  Platform TEXT NOT NULL,              -- Meta | Yandex | TikTok | Google
  Dealer_Type TEXT,
  has_token INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  keyword TEXT,
  goals TEXT,                          -- Yandex_Goal_IDs (одинаково во всех строках дилера)
  health_status TEXT,
  health_days TEXT,
  health_expires TEXT,
  health_checked TEXT,
  PRIMARY KEY (Dealer_ID, Platform)
);

-- Лист Email_Access как есть (кто какие отчёты видит). dealer_email_access не трогаем — это копия из BigQuery для дашборда.
CREATE TABLE IF NOT EXISTS cc_email_access (
  Dealer_ID TEXT NOT NULL,
  Email TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cc_email_access_email ON cc_email_access (Email);

-- Последние записи листов Access_Log и Onboarding_Audit (входы, коды, отказы, действия в админке и портале).
CREATE TABLE IF NOT EXISTS cc_access_log (
  at TEXT NOT NULL,                    -- ISO-время (UTC)
  app TEXT, event TEXT, email TEXT, dealer TEXT, platform TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS cc_access_log_at ON cc_access_log (at);

-- Журнал самого сайта: входы в админку, запуски заданий, смена настроек (раньше писался в Access_Log через Apps Script).
CREATE TABLE IF NOT EXISTS cc_site_log (
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS cc_site_log_at ON cc_site_log (at);

-- Регуляторы из раздела «Квоты»: ключ → значение. Читают Worker (кеш графиков) и задания GitHub (пауза).
CREATE TABLE IF NOT EXISTS cc_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated TEXT
);
