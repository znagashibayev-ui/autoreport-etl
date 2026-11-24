-- Autoreport Hub на сайте (24.11.2026): вкладки Hub (Registry, Mapping, Config, Overrides, Log, Журнал ошибок, Статус,
-- Проверка, Проверка_История, Склейка дублей, __props — служебное состояние очереди и Telegram) — как значения листа (JSON
-- [[...], ...], даты — {"$d": ISO}). Длинные вкладки режутся на части: у D1 предел одного выражения 100 КБ.
-- Пишут etl/hub_run.mjs (задание hub.yml) и сайт (раздел «Autoreport Hub», только Registry / Mapping / Config / Overrides).
CREATE TABLE IF NOT EXISTS hub_sheets (
  name TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name, part)
);
