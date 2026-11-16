-- 11.11.2026: полный контроль медиапланов.
-- cc_mp_cells — последний снимок листа месяца (все ячейки таблицы плана) и итоги «Общий бюджет» (S) по площадкам: план и факт.
-- cc_mp_log — журнал изменений: каждое сравнение снимков, где что-то поменялось (ячейка, было → стало, когда, кто, откуда).
-- cc_mp_baseline — утверждённый план «Общий бюджет» по площадке (platform = '' — весь медиаплан); отклонение видно сразу.
-- cc_mp_changes.gh_run — запуск GitHub, который записал правку (итог действия берётся только из своего запуска).
CREATE TABLE IF NOT EXISTS cc_mp_cells (
  dealer TEXT NOT NULL,
  month TEXT NOT NULL,
  ss TEXT,
  sheet TEXT,
  cells TEXT,          -- JSON: строки листа (значения, столбцы до конца таблицы плана)
  totals TEXT,         -- JSON: {platforms: [{p, plan, fact, planGross, factGross}], plan, fact, planGross, factGross, budget, rate}
  modified TEXT,       -- когда таблицу правили в последний раз (Google Drive)
  who TEXT,            -- кто правил последним (Google Drive)
  at TEXT NOT NULL,    -- когда снят снимок
  PRIMARY KEY (dealer, month)
);

CREATE TABLE IF NOT EXISTS cc_mp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer TEXT NOT NULL,
  month TEXT NOT NULL,
  sheet TEXT,
  at TEXT NOT NULL,    -- когда изменение замечено
  modified TEXT,       -- время правки в Google Drive
  who TEXT,            -- кто правил (Google Drive или «Админка»)
  source TEXT,         -- table | admin | first
  kind TEXT,           -- plan | fact | mixed
  n INTEGER,           -- изменённых ячеек
  changes TEXT,        -- JSON [{a1, row, col, old, new, kind}] (не больше 400)
  totals TEXT          -- JSON изменений итогов S: [{p, plan: [было, стало], fact: [было, стало]}]
);
CREATE INDEX IF NOT EXISTS cc_mp_log_dm ON cc_mp_log (dealer, month, id);
CREATE INDEX IF NOT EXISTS cc_mp_log_at ON cc_mp_log (at);

CREATE TABLE IF NOT EXISTS cc_mp_baseline (
  dealer TEXT NOT NULL,
  month TEXT NOT NULL,
  platform TEXT NOT NULL,  -- '' — весь медиаплан
  plan REAL,               -- «Общий бюджет» (S), план
  plan_gross REAL,         -- бюджет площадки с НДС и АК, ₸
  set_at TEXT NOT NULL,
  set_by TEXT,             -- first (первый снимок) | admin
  PRIMARY KEY (dealer, month, platform)
);

ALTER TABLE cc_mp_changes ADD COLUMN gh_run TEXT;
