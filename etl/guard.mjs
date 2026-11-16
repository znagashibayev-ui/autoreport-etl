#!/usr/bin/env node
// Регулятор из раздела «Квоты» админки: если задание поставлено на паузу (cc_settings, ключ pause.<имя>),
// пишет SKIP=1 в окружение GitHub Actions — следующие шаги задания пропускаются. Ручной запуск паузу не учитывает.
// Использование: node etl/guard.mjs etl | sync

import fs from 'node:fs';
import { d1Query } from './lib/cloudflare.mjs';
import { sqlLiteral } from './lib/sql.mjs';

const name = process.argv[2];
if (!/^[a-z]+$/.test(name || '')) {
  console.error('Укажите имя задания: etl | sync');
  process.exit(2);
}
let paused = false;
if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
  try {
    const rows = d1Query(`SELECT value FROM cc_settings WHERE key = ${sqlLiteral('pause.' + name)}`);
    paused = rows.length > 0 && rows[0].value === '1';
  } catch (err) {
    console.log('Не удалось прочитать паузу (' + err.message + ') — задание выполняется.');
  }
}
if (paused) {
  console.log(`⏸ Задание «${name}» на паузе (админка → Квоты). Пропускаю.`);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, 'SKIP=1\n');
} else {
  console.log(`▶ Задание «${name}» не на паузе.`);
}
