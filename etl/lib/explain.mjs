// Ошибки выгрузки простыми словами: что случилось, почему и что сделать. Используется админкой (Worker) — без зависимостей от Node.
// Порядок правил важен: первое совпадение побеждает.

const RULES = [
  { re: /does not have 'workflow_dispatch' trigger|Workflow does not have/i, what: 'GitHub не прочитал файл задания',
    why: 'В файле задания была ошибка, и GitHub не видел в нём запуска вручную. Файл уже исправлен.',
    fix: 'Нажмите «Исправить» — задание запустится заново.', act: { type: 'retry', label: 'Повторить' } },
  { re: /Нет права записи в медиаплан/i, what: 'Нет права записи в медиаплан',
    why: 'Сервисный аккаунт может только читать эту таблицу, а правке бюджета нужна запись.',
    fix: 'Откройте медиаплан (или всю папку медиапланов) → «Настройки доступа» → autoreport-github@astana-motors-accounts.iam.gserviceaccount.com → роль «Редактор». Затем повторите запись.', act: { type: 'retry', label: 'Доступ выдан — записать снова' } },
  { re: /Медиаплан изменили после того/i, what: 'Медиаплан изменился, пока вы его правили',
    why: 'В строках листа уже не те кампании, что видела админка, — запись остановлена, чтобы не испортить чужие строки.',
    fix: 'Обновите страницу «Медиапланы» (данные перечитаются в течение часа или кнопкой «Перечитать медиапланы») и внесите правку заново.', act: { type: 'reread', label: 'Перечитать медиаплан' } },
  { re: /дневной бюджет в таблице не совпал/i, what: 'Записано, но таблица посчитала другой дневной бюджет',
    why: 'Две причины. 1) Дубль: кампания с таким именем стоит в листе дважды, и формулы делят бюджет между строками (Changan, 11.11.2026). 2) У строки своя формула «Дневного бюджета» — например, «Общий бюджет» делится не на все дни месяца, а на 24 (Hyundai Qalqaman, 12.11.2026); новая кампания копирует формулы последней строки площадки. С 12.11.2026 админка учитывает формулу каждой строки, а имена, отличающиеся только «-»/«_»/регистром, считает одной кампанией.',
    fix: 'Нажмите «Перечитать медиаплан» и повторите правку — бюджеты пересчитаются по формулам строк. Если блок «Контроль медиаплана» показывает дубль — удалите лишнюю кампанию кнопкой 🗑.', act: { type: 'reread', label: 'Перечитать медиаплан' } },
  { re: /Resource has been exhausted|RESOURCE_EXHAUSTED/i, what: 'Google Ads временно ограничил число запросов',
    why: 'Квота API Google Ads (общая с Apps Script) на время закончилась. Токен и доступ в порядке; прежние данные дилера не тронуты.',
    fix: 'Выгрузка сама делает паузу и повтор; если не помогло — нажмите «Повторить» через 15–30 минут. Ночная выгрузка (04:00) тоже загрузит дилера, и ошибка снимется сама.', act: { type: 'retry', label: 'Повторить' } },
  { re: /не подключён к выгрузке.*похожий ID/i, what: 'ID дилера записан по-разному в медиаплане и в листе Total',
    why: 'В Registry Autoreport Hub и в листе Total таблицы All_Tokens один и тот же дилер записан с разными разделителями (например «al_farabi» и «al-farabi»). Регистр букв не важен, а разделители — важны, поэтому выгрузка не нашла дилера.',
    fix: 'Исправьте Dealer_ID в листе Registry Autoreport Hub так, чтобы он совпадал с листом Total (похожий ID указан в тексте ошибки), подождите пересчёт недолётов и снова нажмите «Восстановить».', act: { type: 'link', href: 'https://docs.google.com/spreadsheets/d/16N9XPIWTnkMAu41kPQg-byRe9kYM2NDx-elQh8DOAak/edit', label: 'Открыть Registry Autoreport Hub' } },
  { re: /не подключён к выгрузке/i, what: 'Дилер не подключён к выгрузке AutoReport',
    why: 'Его кабинета этой площадки нет в листе Total таблицы All_Tokens (или нет токена), поэтому ни GitHub, ни Apps Script его не загружают. Медиаплан Hub при этом заполняется, отсюда «недолёт».',
    fix: 'Подключите дилера через портал dm-astana-motors.kz (кнопка площадки) или добавьте строку в лист Total, затем Задания → «Синхронизация таблиц» и снова «Восстановить».', act: { type: 'link', href: 'https://autoreport-connect.dm-astana-motors.kz/', label: 'Открыть портал подключения' } },
  { re: /Нет секретов GitHub для Google Ads/i, what: 'Не заданы ключи приложения Google Ads',
    why: 'Выгрузке Google нужны три секрета в GitHub, без них она не стартует.',
    fix: 'GitHub → репозиторий autoreport-etl → Settings → Secrets and variables → Actions: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN.', act: { type: 'link', href: 'https://github.com/znagashibayev-ui/autoreport-etl/settings/secrets/actions', label: 'Открыть секреты GitHub' } },
  { re: /не JSON|after JSON|Unexpected token|unknown error occurred \(code 1\)|code 2\)|reduce the amount of data/i, what: 'Meta не смогла собрать отчёт',
    why: 'Так Meta отвечает на слишком большой отчёт (много кабинетов, объявлений и дней) или при сбое на своей стороне. Выгрузка уже делит период на части; эта ошибка значит, что не помогло и деление.',
    fix: 'Запустите этого дилера ещё раз позже. Если повторяется — запустите за более короткий период (месяц) и пришлите итог.', act: { type: 'retry', label: 'Повторить' } },
  { re: /code 190\)|access token|session has expired|Error validating/i, platform: 'Meta', what: 'Токен Meta недействителен',
    why: 'Токен дилера истёк или отозван (сменили пароль, сняли доступ приложения).',
    fix: 'Переподключите Meta этого дилера через портал (страница подключения) или обновите Meta_Token в листе Total.', act: { type: 'link', href: 'https://autoreport-connect.dm-astana-motors.kz/', label: 'Открыть портал подключения' } },
  { re: /code (10|200|294)\)|permission|does not have access|Unsupported get request/i, platform: 'Meta', what: 'Нет доступа к кабинету Meta',
    why: 'У токена нет прав на этот рекламный кабинет, или кабинет удалён/неверный ID.',
    fix: 'Проверьте ID кабинета в листе Total / реестре и что пользователь токена — админ или аналитик кабинета.', act: { type: 'link', href: 'https://autoreport-connect.dm-astana-motors.kz/', label: 'Открыть портал подключения' } },
  { re: /code (4|17|32|613|8000\d)\)|request limit|too many calls/i, what: 'Превышен лимит запросов',
    why: 'Площадка временно ограничила число запросов. Выгрузка повторяла попытки, но лимит не снялся.',
    fix: 'Ничего делать не нужно — следующий запуск (ночью) выгрузит дилера. Если срочно — запустите его отдельно через час.', act: { type: 'retry', label: 'Повторить' } },
  { re: /нет access_token|invalid_grant/i, what: 'Доступ Google Ads отозван',
    why: 'Refresh token Google в листе Total больше не действует (отозван доступ или сменён пароль).',
    fix: 'Переподключите Google этого дилера через портал или обновите Google_Token в листе Total.', act: { type: 'job', file: 'google-mcc.yml', inputs: { apply: '1', start: '2026-01-01' }, label: 'Вписать рабочий токен MCC' } },
  { re: /caller does not have permission|USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED/i, what: 'Аккаунт Google Ads не привязан к MCC',
    why: 'Аккаунт не находится под управляющим аккаунтом 5297548449 — его нельзя выгрузить ни отсюда, ни из Apps Script.',
    fix: 'В Google Ads отправьте аккаунту приглашение от MCC 5297548449 и примите его, либо уберите ID из листа Total.', act: { type: 'link', href: 'https://ads.google.com/aw/accounts', label: 'Открыть аккаунты MCC в Google Ads' } },
  { re: /DEVELOPER_TOKEN|developer token/i, what: 'Developer token Google Ads не принят',
    why: 'Секрет GOOGLE_ADS_DEVELOPER_TOKEN неверный или у токена нет нужного уровня доступа.',
    fix: 'Сверьте значение секрета с GoogleAds_ETL.gs (строка 11) и обновите его в GitHub.', act: { type: 'link', href: 'https://github.com/znagashibayev-ui/autoreport-etl/settings/secrets/actions', label: 'Открыть секреты GitHub' } },
  { re: /TikTok API.*code=(40001|40100|40105|40102)|access token.*tiktok/i, what: 'Токен TikTok недействителен',
    why: 'Токен дилера истёк или отозван.', fix: 'Переподключите TikTok этого дилера через портал.', act: { type: 'link', href: 'https://autoreport-connect.dm-astana-motors.kz/', label: 'Открыть портал подключения' } },
  { re: /Яндекс|Yandex|code(=| )?(53|513)\b/i, what: 'Ошибка Яндекс.Директа',
    why: 'Чаще всего — истёкший токен или неверный логин клиента.', fix: 'Проверьте Yandex_Token и Yandex_Client_Login в листе Total или переподключите Яндекс через портал.', act: { type: 'link', href: 'https://autoreport-connect.dm-astana-motors.kz/', label: 'Открыть портал подключения' } },
  { re: /Нет курса|fxMissing/i, what: 'Нет курса валют за месяц',
    why: 'Без курса расход в тенге не пересчитать.', fix: 'Админка → «Курсы валют» → задайте курс за этот месяц и нажмите «Пересчитать».', act: { type: 'link', href: '#fx', label: 'Открыть «Курсы валют»' } },
  { re: /Quota exceeded|RESOURCE_EXHAUSTED|Read requests per minute/i, what: 'Превышен лимит чтения Google Таблиц',
    why: 'Google разрешает 60 чтений таблиц в минуту, а выгрузка читает лист Total и медиапланы всех дилеров подряд.',
    fix: 'Ничего делать не нужно: с 06.11 выгрузка при лимите ждёт до минуты и повторяет. Если ошибка повторится — пришлите итог.', act: { type: 'retry', label: 'Повторить' } },
  { re: /Таблица .*(403|PERMISSION|permission)|не прочитан/i, what: 'Нет доступа к таблице Google',
    why: 'Сервисный аккаунт выгрузки не может открыть таблицу.',
    fix: 'Откройте таблицу → «Настройки доступа» → добавьте autoreport-github@astana-motors-accounts.iam.gserviceaccount.com как «Читатель».', act: { type: 'retry', label: 'Доступ выдан — повторить' } },
  { re: /нет связи|fetch failed|ETIMEDOUT|ECONNRESET|HTTP 5\d\d/i, what: 'Площадка не ответила',
    why: 'Сбой сети или сервера площадки; выгрузка повторяла попытки.', fix: 'Ничего делать не нужно — следующий запуск выгрузит дилера.', act: { type: 'retry', label: 'Повторить' } }
];

/**
 * @param {string} text  текст ошибки из итога запуска
 * act — что делает кнопка «Исправить»: retry (повторить это действие), reread (перечитать медиаплан дилера),
 *       job (запустить задание file с inputs), link (открыть страницу href, где исправляется вручную).
 * @returns {{what: string, why: string, fix: string, act: object|null}}
 */
export function explainError(text) {
  const s = String(text || '');
  for (const r of RULES) {
    if (r.platform && s.indexOf(r.platform) === -1) continue;
    if (r.re.test(s)) return { what: r.what, why: r.why, fix: r.fix, act: r.act || null };
  }
  return { what: 'Неизвестная ошибка', why: 'Этот случай ещё не разобран.', fix: 'Нажмите «Повторить». Если ошибка вернётся — пришлите её текст (ниже), разберу и добавлю сюда объяснение.', act: { type: 'retry', label: 'Повторить' } };
}

/** Проблемы запуска etl_runs (detail) списком с объяснениями: дилеры с ошибкой, ошибка запуска, нет курсов. */
export function runProblems(d) {
  const out = [];
  for (const f of Array.isArray(d.failed) ? d.failed : []) out.push({ dealer: f.dealer, error: f.error, ...explainError(f.error) });
  if (d.error) out.push({ dealer: '', error: d.error, ...explainError(d.error) });
  if (Array.isArray(d.fxMissing) && d.fxMissing.length) {
    const months = [...new Set(d.fxMissing.map((m) => m.month))].join(', ');
    out.push({ dealer: '', error: 'Нет курса за ' + months, ...explainError('Нет курса') });
  }
  return out;
}
