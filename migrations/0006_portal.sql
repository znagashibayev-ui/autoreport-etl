-- Портал подключения дилеров без Apps Script (этап 5, 05.11.2026). Worker autoreport-portal.
-- Источник правды о токенах — по-прежнему лист Total таблицы All_Tokens (его читают выгрузки).
-- Здесь токены лежат только зашифрованными (AES-GCM, ключ — секрет PORTAL_ENC_KEY в Cloudflare) и только до записи в таблицу.

-- Подключённые площадки сессии подключения (аналог листа Onboarding_Staging). Живут 24 часа.
CREATE TABLE IF NOT EXISTS portal_staged (
  email TEXT NOT NULL,
  platform TEXT NOT NULL,              -- Meta | Yandex | TikTok | Google
  token_enc TEXT NOT NULL,
  fp TEXT,                             -- отпечаток токена (первые 4 байта SHA-256), сам токен не раскрывает
  created TEXT NOT NULL,
  PRIMARY KEY (email, platform)
);

-- Заявки: регистрация нового аккаунта, обновление токена существующего, заявка на проверку (claim).
CREATE TABLE IF NOT EXISTS portal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  email TEXT NOT NULL,
  dealer TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- register | update | claim
  status TEXT NOT NULL,                -- queued | writing | done | failed | review | approved | rejected
  chosen TEXT NOT NULL,                -- JSON { platform: [{id, name}] }
  goals TEXT,
  tokens_enc TEXT,                     -- JSON { platform: шифр } — стирается после записи в таблицу
  fps TEXT,                            -- JSON { platform: отпечаток }
  note TEXT,
  applied TEXT,
  etl TEXT                             -- JSON о первой выгрузке: { platform: 'запущена' | ошибка }
);
CREATE INDEX IF NOT EXISTS portal_requests_status ON portal_requests (status);
CREATE INDEX IF NOT EXISTS portal_requests_email ON portal_requests (email);

-- Журнал портала (аналог листа Onboarding_Audit; задание записи копирует события и в сам лист).
CREATE TABLE IF NOT EXISTS portal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  email TEXT,
  dealer TEXT,
  platform TEXT,
  detail TEXT,
  sheet INTEGER NOT NULL DEFAULT 0     -- 1 = уже записано в лист Onboarding_Audit
);
CREATE INDEX IF NOT EXISTS portal_log_at ON portal_log (at);
CREATE INDEX IF NOT EXISTS portal_log_sheet ON portal_log (sheet);
