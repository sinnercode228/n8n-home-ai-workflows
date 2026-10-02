# n8n-home-ai-workflows

[English](README.md) · **Русский**

[![CI](https://github.com/sinnercode228/n8n-home-ai-workflows/actions/workflows/ci.yml/badge.svg)](https://github.com/sinnercode228/n8n-home-ai-workflows/actions/workflows/ci.yml)

Четыре воркфлоу n8n для домашнего сервера на Docker Compose: заметки со встреч в Notion через Claude, утренняя сводка семейных календарей, ответы по домашним документам на локальной Ollama и общий обработчик ошибок. Compose поднимает для них n8n 2.40.6, а по профилям ещё Ollama, Qdrant и Caddy. JavaScript в Code-нодах генерируется из модулей в `src/`, и тесты исполняют этот код ровно в том виде, в каком он лежит в JSON воркфлоу.

Это демо на выдуманных данных, а не проект для клиента. Семья Alder, её календари, документы в `samples/docs/` и все идентификаторы придуманы, почтовые адреса на зарезервированном домене `home.example`. Ключей в репозитории нет: каждое значение, которое нужно вписать своё, выглядит как `REPLACE_WITH_...`, а `npm run validate` показывает, сколько таких осталось в каждом воркфлоу.

README написан как лабораторный журнал. Для каждого воркфлоу ниже: что я на самом деле запускал, что не запускал ни разу и как подключить настоящие аккаунты. Коротко: JavaScript всех 18 Code-нод выполнялся в песочнице Node `vm` на рукописных файлах из `samples/`. Ни одна нода, которая ходит в Anthropic, Notion, Google, Telegram, Ollama или Qdrant, против живого сервиса не выполнялась.

## Четыре воркфлоу

| Воркфлоу | Запуск | Что делает | Сервисы, модели | Нод / Code-нод |
|---|---|---|---|---|
| [`meeting-notes-to-notion`](workflows/meeting-notes-to-notion.json) | вебхук `POST /webhook/meeting-notes` (header auth) | транскрипт → Claude → JSON с резюме, решениями и задачами → страница в базе Notion Meetings, строка на каждую задачу в Tasks, событие на весь день в Google Calendar для задач со сроком; алерт в Telegram при сбое | Claude Messages API, `claude-opus-5`; Notion; Google Calendar; Telegram | 18 / 6 |
| [`family-calendar-digest`](workflows/family-calendar-digest.json) | каждый день в 07:00 (`0 7 * * *`) | события дня из четырёх семейных календарей без дублей, с отмеченными пересечениями → текст от LLM или по шаблону, если LLM не ответила → черновик в Gmail и сообщение в Telegram | Google Calendar; `claude-opus-5` или Ollama `llama3.1:8b`; Gmail; Telegram | 12 / 4 |
| [`private-doc-qa-local-llm`](workflows/private-doc-qa-local-llm.json) | вебхук `POST /webhook/doc-qa` (header auth); переиндексация в 02:30 (`30 2 * * *`) и вручную | ответ на вопрос по `.md` и `.txt` из папки документов с нумерованными ссылками на файл и раздел | Ollama `nomic-embed-text` (768 измерений) и `llama3.1:8b`; Qdrant | 27 / 6 |
| [`error-handler`](workflows/error-handler.json) | Error Trigger; три остальных указывают на него в `settings.errorWorkflow` | строка в `/logs/n8n-errors.jsonl` с замаскированными ключами и токенами и алерт в Telegram с подсказкой; одна и та же ошибка алертит не чаще раза в 30 минут | Telegram | 9 / 2 |

Число нод взято из вывода `npm run validate` (стикеры не считаются). Все четыре выгружены с `active: false`, активный экспорт валидатор не пропускает.

![Воркфлоу meeting-notes-to-notion в редакторе n8n, внизу петля Plan Retry → Retry? → Wait (Backoff)](docs/screenshots/meeting-notes-to-notion.png)

Остальные холсты: [сводка календарей](docs/screenshots/family-calendar-digest.png), [Q&A по документам](docs/screenshots/private-doc-qa-local-llm.png), [обработчик ошибок](docs/screenshots/error-handler.png). Схема потоков данных и таблица по каждому воркфлоу, что уходит из дома, лежат в [`docs/architecture.md`](docs/architecture.md). Перезапуск, бэкапы и ротация ключей для домашних описаны в [`docs/runbook.md`](docs/runbook.md).

## Что уходит из дома

Транскрипт встречи уходит в Anthropic целиком, вместе с названием, датой и именами участников. В сводке календарей Claude получает названия событий, время, имена членов семьи и пересечения. Места и заметки к событиям попадают в запрос, только если в Config стоит `sendLocationsToCloud: true` (`src/calendar/digest.js:35`); с `llmProvider: "ollama"` локальная модель получает всё, а во внешнюю LLM не уходит ничего. Юнит-тест `buildDigestRequest: privacy` и mock-прогон ноды `Build Digest Request` проверяют, что места из примера в облачный запрос не попадают. Готовая сводка всё равно уходит в Gmail и Telegram.

Q&A по документам помечен тегом `local-only`. Для таких воркфлоу [`scripts/validate.mjs`](scripts/validate.mjs) отклоняет ноды облачных сервисов (16 шаблонов в `CLOUD_NODE_TYPES`), подставляет значения из Config в URL каждой HTTP-ноды и пропускает только локальные хосты вроде `ollama`, `qdrant`, `localhost` и `host.docker.internal`; URL в самом Config проходят ту же проверку (`scripts/validate.mjs:263-278`). На это есть негативный тест (`tests/validator.test.mjs:51-59`). Чего эта проверка не видит, написано в [известных ограничениях](#известные-ограничения). При сбое имя ноды и текст ошибки всё же уходят в Telegram через error-handler; ключи и токены в тексте маскирует [`redact.js`](src/shared/redact.js).

## Что значит «прогнано» и «не проверено»

**Прогнано.** [`tests/harness.mjs`](tests/harness.mjs) достаёт `jsCode` из `workflows/*.json` и выполняет его через `vm.runInNewContext` с поддельными `$input`, `$('Node')`, `$runIndex`, `$workflow`, `$execution` и `$getWorkflowStaticData` (`tests/harness.mjs:35-55`). [`tests/workflows.test.mjs`](tests/workflows.test.mjs) гоняет Code-ноды каждого воркфлоу цепочкой и подставляет файлы из `samples/` туда, где был бы ответ сервиса. Юнит-тесты вызывают модули из `src/` напрямую.

| Файл | Тестов | Что проверяют |
|---|---|---|
| [`tests/unit.test.mjs`](tests/unit.test.mjs) | 33 | модули из `src/`: бэкофф, разбор ответов LLM, починка JSON, валидация заметок, окно дня, чанки, цитаты, отпечатки ошибок |
| [`tests/workflows.test.mjs`](tests/workflows.test.mjs) | 8 | mock-прогоны настоящего `jsCode` всех четырёх воркфлоу, в том числе 429 → повтор и 401 → алерт без повтора |
| [`tests/validator.test.mjs`](tests/validator.test.mjs) | 7 | все воркфлоу проходят, испорченные копии ловятся: битая связь, ключ в заголовке, credential в JSON, вебхук без авторизации, облачный хост в `local-only`, дрейф Code-ноды, error-выход без `continueErrorOutput` |

**Не проверено.** Нода ни разу не выполнялась внутри n8n с настоящим ответом сервиса; её параметры проверены только статически в [`scripts/validate.mjs`](scripts/validate.mjs): связи, ссылки `$('Node')`, таймауты HTTP, ссылки на credentials только по имени, авторизация вебхуков, ключи в открытом виде. Это касается всех нод, кроме Code: 11 HTTP Request, Notion ×2, Google Calendar ×2, Gmail, Telegram ×3, Send Email ×2 (выключены), Wait, Read/Write Files ×2, Convert to File, Extract From File, Respond to Webhook ×3, триггеров, Config (Set) и IF/Switch. Ответы сервисов в `samples/` написаны руками, а не сняты с живых API.

### Как собираются Code-ноды

n8n хранит код Code-ноды строкой `parameters.jsCode` прямо в JSON воркфлоу. Здесь все 18 таких строк сгенерированы. Логика лежит в `src/` как ES-модули, а [`scripts/lib/code-nodes.mjs`](scripts/lib/code-nodes.mjs) описывает, какие модули идут в какую ноду, плюс короткий `entry` для каждой. `entry` — единственное место, которое обращается к `$input`, `$('Node')` и `$runIndex`.

`npm run build` ([`scripts/build-workflows.mjs`](scripts/build-workflows.mjs)) обходит относительные импорты, ставит зависимости раньше зависимых, вырезает `import` и `export` и падает на цикле импортов. `npm run check:build` выходит с кодом 1, если хоть один воркфлоу отличается от сборки, а `scripts/validate.mjs` компилирует каждую Code-ноду через `new vm.Script(...)` и сравнивает с тем, что получилось бы из `src/`. Поэтому правку из редактора n8n приходится руками переносить в `src/` и запускать `npm run build`.

## 1. Заметки встреч → Notion

Цепочка: Transcript Webhook (отвечает 202 сразу, `responseMode: onReceived`) → Config → Normalize Transcript → Build Claude Request → HTTP `Claude: Extract Notes` (`api.anthropic.com/v1/messages`) → Parse & Validate Notes → Notion: Create Meeting Page → Prepare Tasks → Notion: Create Task (по одной на пункт) → Google Calendar: Add Deadline (событие на весь день) для задач со сроком. Невалидные заметки и упавшие запросы уходят в Build Alert → Telegram.

Запрос собирает [`src/meeting/claude-request.js`](src/meeting/claude-request.js): модель из Config (`claude-opus-5`), JSON Schema заметок в `output_config.format` (`src/meeting/claude-request.js:10-36`), `output_config.effort: "medium"` и `fallbacks: "default"`; обе HTTP-ноды Claude ещё шлют заголовок `anthropic-beta: server-side-fallback-2026-07-01`. [`llm-response.js`](src/shared/llm-response.js) берёт текст только из блоков `text` и считает ошибкой `stop_reason: refusal` или `max_tokens` (`src/shared/llm-response.js:25-46`); тогда в Notion ничего не пишется и уходит алерт. При structured outputs текст должен сразу разбираться как JSON; на случай, если нет, [`json-repair.js`](src/shared/json-repair.js) снимает Markdown-ограду, лишний текст вокруг, «умные» кавычки и висячие запятые. Потом [`validate-notes.js`](src/meeting/validate-notes.js) проверяет содержимое: без `summary` страница не создаётся; несуществующая дата вроде `2026-02-30` или срок раньше встречи стираются, дубль задачи выбрасывается, и каждая такая правка становится предупреждением в блоке «Processing notes» на странице Notion.

**Петля повторов.** Error-выход ноды `Claude: Extract Notes` (`onError: continueErrorOutput`) ведёт в Code-ноду `Plan Retry`, дальше IF `Retry?` и `Wait (Backoff)`, откуда запрос возвращается в ту же HTTP-ноду. Зачем она, написано в шапке [`src/shared/backoff.js`](src/shared/backoff.js):

> n8n's built-in "Retry On Fail" waits a fixed time (max 5 s) between tries. Rate limits (429) and overload (529) deserve real exponential backoff, and a 400/401 should not be retried at all - so the workflow loops through a Wait node using the plan computed here.

Повторяются 408, 409, 429, 500, 502, 503, 504, 529 и сетевые ошибки без статуса, остальное сразу уходит алертом в Telegram. Счётчик попыток нигде не хранится: номер упавшей попытки равен `$runIndex + 1` у `Plan Retry`. Пауза случайная, от exp/2 до exp, где exp = min(300, 10 · 2^(n−1)) с, так что при `maxAttempts: 4` и `retryBaseSeconds: 10` из Config выходит 5–10, 10–20 и 20–40 с, потом алерт. Вебхук к этому моменту уже ответил 202, поэтому отправитель паузы не ждёт.

Что я прогонял (`tests/workflows.test.mjs:23-92`):

- `samples/fathom-webhook.json` → Normalize Transcript → Build Claude Request: в запросе модель из Config, формат `json_schema` и транскрипт с таймкодами и именами говорящих.
- `samples/anthropic-meeting-response.json` (пустой thinking-блок, потом JSON в text-блоке) → Parse & Validate Notes → Prepare Tasks с фейковым id страницы Notion: три задачи, владельцы сопоставлены с участниками, у задачи без исполнителя `Unassigned`.
- `samples/anthropic-meeting-response-messy.json` (JSON в Markdown-ограде, висячая запятая, дата 2026-02-30, срок раньше встречи, дубль задачи) → починено; остаются две задачи, предупреждения попадают в текст «Processing notes».
- Plan Retry: 429 на первой попытке → повтор через 5–10 с, запрос к Claude проходит через Wait; 529 на последней попытке → сдаться; 401 → без повтора, и Build Alert собирает Telegram-HTML с названием встречи и ссылкой на execution.
- `samples/anthropic-refusal.json` → `ok: false` на стадии `claude-response` → алерт.
- Юнит-тесты: `normalizeTranscript` на payload'ах Fathom, Granola и общем; схема закрыта и все поля обязательны, как требуют structured outputs (`tests/unit.test.mjs:143-154`); `validateMeetingNotes`; `planRetry` с подставным random; `redactSecrets`.

Что я не запускал:

- Ни одного запроса к api.anthropic.com. Как API отвечает именно на такой запрос (`output_config.format`, `effort`, `fallbacks` и бета-заголовок), я не видел.
- Петлю Wait → HTTP внутри n8n. Счётчик попыток рассчитывает на то, что n8n увеличивает `$runIndex` у `Plan Retry` на каждом витке (`scripts/lib/code-nodes.mjs:34-48`), а error-выход HTTP-ноды несёт код статуса в одном из полей, которые читает `statusFromError` (`src/shared/backoff.js:11-21`). Тесты кормят `Plan Retry` рукописными объектами вроде `{ error: { httpCode: 529 } }`.
- Обе Notion-ноды (ключи свойств вида `Due|date` и `Meeting|relation`, пустые даты), Google Calendar: Add Deadline, Telegram: Alert, header auth на вебхуке.
- Настоящие payload'ы Fathom и Granola. Сэмплы угадывают имена полей (см. `_comment` в `samples/fathom-webhook.json` и `samples/granola-webhook.json`); сопоставление полей в одном месте, `src/meeting/normalize-transcript.js:55-89`.

Как подключить настоящие аккаунты:

1. Credentials: Anthropic, `Webhook shared secret (meeting recorder)`, Notion, Google Calendar, Telegram (точные имена в разделе [Credentials](#credentials)).
2. Две базы в Notion, расшаренные интеграции. Meetings: заголовок, `Date` (date), `Source` (select), `Attendees` (text), `Recording` (URL). Tasks: заголовок, `Owner` (text), `Due` (date), `Priority` (select: high, normal, low), `Status` (select со значением `To do`), `Meeting` (relation на Meetings). Если колонки называются иначе, перевыбрать свойства в двух Notion-нодах.
3. Config-нода: `notionMeetingsDbId`, `notionTasksDbId`, `telegramChatId`. По желанию: `n8nBaseUrl` для ссылок на execution в алертах, `calendarId` (по умолчанию `primary`), `createCalendarEvents: false`, если события в календаре не нужны, `maxAttempts` и `retryBaseSeconds`. `useServerFallbacks: false` убирает `fallbacks` из тела запроса, но бета-заголовок прописан в HTTP-ноде статически и остаётся.
4. Первый живой прогон, воркфлоу активирован:

   ```bash
   curl -X POST http://localhost:5678/webhook/meeting-notes \
     -H "X-Webhook-Secret: <секрет>" -H "Content-Type: application/json" \
     --data @samples/fathom-webhook.json
   ```

   Имя заголовка — то, что указано в Header Auth credential. Ответ приходит сразу (202), результат смотреть в Executions. В транскрипте из примера есть задача без срока (батарейки в датчиках дыма), так что этот прогон, скорее всего, сразу отправит в Notion пустую дату; это первое, что стоит проверить.

## 2. Семейная сводка календарей

Цепочка: Every Day 07:00 → Config → Expand Calendars (окно «сегодня» в часовом поясе семьи, по одному item на календарь) → Google Calendar: Today's Events → Merge & Dedupe Events (общие события склеиваются по `iCalUID` + начало, отменённые выбрасываются, пересечения отмечаются) → Build Digest Request → Route: Which Writer? (Claude, Ollama или «Nothing today» без вызова LLM) → Compose Digest → Gmail: Create Draft и Telegram: Send Digest.

У `Claude: Write Digest` встроенный Retry On Fail (3 попытки через 5 с) и `onError: continueRegularOutput`. Если LLM так и не ответила, [`digest.js`](src/calendar/digest.js) собирает сводку по шаблону и добавляет строку о том, что ИИ сегодня недоступен. В Gmail создаётся черновик, само письмо не отправляется.

[`day-window.js`](src/calendar/day-window.js) ищет UTC-момент локальной полуночи в два прохода, потому что в дни перевода часов смещение меняется. Тест проверяет, что 1 ноября 2026 года в `America/New_York` длится 25 часов.

Что я прогонял (`tests/workflows.test.mjs:94-134`):

- `samples/google-calendar-events.json` (4 календаря, одно событие есть в двух, одно отменено, одно пересечение) → Expand Calendars → Merge & Dedupe Events → Build Digest Request: 5 событий, 1 пересечение, адреса стоматолога («Maple St Dental») в запросе к Claude нет.
- Compose Digest с `samples/ollama-digest-response.json`: используется текст LLM, сообщение в Telegram не длиннее 4000 символов.
- Пустой день: маршрут `none`, LLM не вызывается, в письме «Nothing is on the family calendar».
- Юнит-тесты: окно дня, включая 25-часовые сутки (`tests/unit.test.mjs:207-214`); `mergeEvents`; разделение данных между Claude и Ollama; шаблонная сводка после ошибки `ECONNREFUSED`.

Что я не запускал:

- Google Calendar: Today's Events. Merge & Dedupe Events привязывает событие к члену семьи через `pairedItem` (`scripts/lib/code-nodes.mjs:108-119`); настоящего `pairedItem` на выходе ноды я не видел, как и того, что `alwaysOutputData` отдаёт для пустого календаря (в тесте это `{}`). Нода просит `orderBy: startTime` и оставляет обработку повторяющихся событий на дефолте ноды, а сэмпл предполагает `singleEvents=true`. Если Google не примет такую сортировку, `orderBy` можно убрать: `mergeEvents` сортирует сам (`src/calendar/merge-events.js:54`).
- Ветку Claude с настоящим ответом. Сэмпла ответа Claude для сводки нет: прогон Compose Digest идёт на ответе Ollama, а разбор текста Anthropic проверен на рукописном массиве `content` (`tests/unit.test.mjs:62-69`).
- Ollama: Write Digest, Gmail: Create Draft (опция `sendTo`), Telegram: Send Digest.
- Что Retry On Fail вместе с `continueRegularOutput` после последней попытки действительно отдаёт в Compose Digest item с полем `error`, а не останавливает выполнение.

Как подключить настоящие аккаунты:

1. Credentials: `Google Calendar (household)`, `Gmail (household)`, `Telegram bot (household alerts)`; Anthropic только при `llmProvider: "claude"`.
2. Config-нода: четыре id календарей (`member` — как подписывать события этого календаря), `telegramChatId`, `digestEmailTo`, `familyName`, `timezone`, `llmProvider` (`"claude"` или `"ollama"`), `sendLocationsToCloud`.
3. Чтобы не ждать 07:00, нажать Execute workflow в редакторе. Это настоящий запуск: черновик в Gmail создастся, сообщение в Telegram уйдёт.

## 3. Вопросы по домашним документам (локально)

Переиндексация (ручной триггер или `30 2 * * *`): Qdrant: Collection Exists? → создать коллекцию, если её нет (768 измерений, cosine) → Read Documents (`/data/docs/**/*.{md,txt}`) → Extract Text → Chunk Documents (1200 символов, перекрытие 200, запоминается ближайший Markdown-заголовок) → Ollama `/api/embed` на каждый чанк → Build Qdrant Points (детерминированные id) → Qdrant: Delete Old Chunks для этих файлов → upsert батчами по 64.

Вопрос: `POST /webhook/doc-qa` → Validate Question (400, если вопроса нет или он слишком длинный) → эмбеддинг → поиск в Qdrant (`topK` 6) → Build Grounded Prompt → Ollama `/api/chat` → Format Answer → JSON-ответ. Хиты ниже `minScore` 0.35 отбрасываются; если не осталось ни одного, LLM не вызывается и вебхук отвечает с `grounded: false`. [`rag.js`](src/docqa/rag.js) вырезает ссылки `[n]` на несуществующие источники, которые маленькие локальные модели иногда придумывают, и пишет об этом предупреждение. Форма ответа: `{ ok, question, answer, grounded, citations: [{ n, path, heading, score, excerpt }], warnings, model }`.

Что я прогонял (`tests/workflows.test.mjs:136-168`):

- Три файла из `samples/docs/` через Chunk Documents с подделанными binary-метаданными (`fileName`, `directory`): пути получились относительно `/data/docs`, заголовки сохранены.
- Эмбеддинги подменены 8-мерными массивами → Build Qdrant Points → Split Upsert Batches.
- Вопрос → Validate Question → Build Grounded Prompt на `samples/qdrant-search-response.json` (хит со score 0.21 отброшен) → Format Answer на `samples/ollama-answer-response.json`: `grounded: true`, первая ссылка на `home/boiler.md`.
- Юнит-тесты: `chunkDocument` на `boiler.md`, батчи по 64 (70 точек → 64 + 6), `normalizeQuestion`, `buildRagRequest` и `formatAnswer`, который вырезает из того же сэмпла выдуманную ссылку `[7]` с предупреждением.

Что я не запускал:

- Сами Ollama и Qdrant. Форма ответов `/api/embed` (код берёт `embeddings[0]`), `/collections/{name}/exists`, `/points/delete`, `/points?wait=true` и `/points/search` взята из документации.
- Read/Write Files и Extract From File: приходят ли `binary.data.directory` и `fileName` в том виде, который ждёт Chunk Documents (`scripts/lib/code-nodes.mjs:144-159`), срабатывает ли glob с `{md,txt}` и пропускает ли `N8N_RESTRICT_FILE_ACCESS_TO` из `docker-compose.yml` путь `/data/docs`.
- Три ноды Respond to Webhook и header auth на вебхуке.
- Качество ответов `llama3.1:8b` на настоящих документах я не измерял.

Попробовать этот воркфлоу проще всего: ему нужен один credential, `Webhook shared secret (doc Q&A)` (Header Auth), и никаких внешних аккаунтов. Когда стек поднят и модели скачаны (см. [Установку](#установка)):

```bash
cp -r samples/docs/* documents/
# в редакторе: запустить «Manual: Re-index Documents», потом активировать воркфлоу
curl -X POST http://localhost:5678/webhook/doc-qa \
  -H "X-Webhook-Secret: <секрет>" -H "Content-Type: application/json" \
  -d '{"question": "When is the boiler service due?"}'
```

Заглушек в Config-ноде нет. На Apple Silicon Docker не использует GPU, поэтому [`docker-compose.yml`](docker-compose.yml) советует нативную Ollama: убрать `ollama` из `COMPOSE_PROFILES` и прописать в Config `"ollamaBaseUrl": "http://host.docker.internal:11434"`; валидатор считает этот хост локальным.

## 4. Обработчик ошибок

Цепочка: Error Trigger → Config → Build Error Record → Log Line to File → Append to Error Log (`/logs/n8n-errors.jsonl`); параллельно Alert? → Format Alert → Telegram: Error Alert (плюс выключенная нода e-mail). Запись и решение «алертить или нет» строит [`error-record.js`](src/errors/error-record.js). Отпечаток собирается из id воркфлоу, имени ноды и сообщения, где цифры заменены на `#`; повтор в пределах `alertWindowMinutes` (30) пишется в лог, но не алертит. Ошибки severity `high` (401, 403, credentials) алертят всегда.

Остальные три воркфлоу ссылаются на него через `settings.errorWorkflow: "HmErrorHandler01"`. Валидатор требует, чтобы этот id принадлежал воркфлоу из репозитория с Error Trigger, а у самого обработчика не было своего error workflow, чтобы не зациклиться (`scripts/validate.mjs:118-127`).

Что я прогонял (`tests/workflows.test.mjs:170-188`):

- `samples/error-trigger.json` (401 с фейковым ключом в тексте) → Build Error Record: алерт включён, ключа в строке лога нет, отпечаток записан в static data → Format Alert: HTML с подсказкой про ротацию ключей и ссылкой на execution.
- Юнит-тесты: `buildErrorRecord` (severity `high`, маскировка, ошибки execution и trigger) и `shouldAlert` (повтор через 10 минут молчит, через 31 алертит, `high` алертит всегда).

Что я не запускал:

- Настоящий payload Error Trigger в n8n 2.x. Сэмпл рукописный; код читает и `execution.error`, и `trigger.error` (`src/errors/error-record.js:24-29`).
- Запись в `/logs` через Convert to File с append и права на `./logs` на Linux-хосте.
- Сохранение static data между запусками; Telegram: Error Alert.

Как подключить: credential `Telegram bot (household alerts)` и `telegramChatId` в Config. В каждом JSON зашит постоянный id воркфлоу (у этого `HmErrorHandler01`), на него ссылается `errorWorkflow`, поэтому импортировать стоит командами из [Установки](#установка). После импорта проверить в настройках каждого воркфлоу, что Error workflow указывает на «Global error handler», и выбрать его там вручную, если нет (например, после импорта через UI).

## Credentials

Ноды ссылаются на credentials по имени, поэтому создавать их в n8n (Credentials → Add) нужно ровно с такими именами. Ключи API хранятся там, зашифрованные `N8N_ENCRYPTION_KEY`, а не в `.env`.

| Имя | Тип | Где используется |
|---|---|---|
| `Anthropic API key (x-api-key header)` | Header Auth, заголовок `x-api-key` | заметки встреч; сводка при `llmProvider: "claude"` |
| `Webhook shared secret (meeting recorder)` | Header Auth, например `X-Webhook-Secret` и случайная строка | вебхук заметок встреч |
| `Webhook shared secret (doc Q&A)` | Header Auth | вебхук Q&A по документам |
| `Notion (household workspace)` | Notion API | заметки встреч |
| `Google Calendar (household)` | Google Calendar OAuth2 | заметки встреч, сводка |
| `Gmail (household)` | Gmail OAuth2 | сводка |
| `Telegram bot (household alerts)` | Telegram API | заметки встреч, сводка, обработчик ошибок |
| `SMTP (household alerts)` | SMTP | только если включить выключенные ноды e-mail |

Потом заменить 9 значений `REPLACE_WITH_...` в Config-нодах: id чата Telegram в трёх воркфлоу, два id баз Notion и четыре id календарей. С профилем `proxy` вебхуки идут в обход basic auth Caddy и защищены только этими заголовками с секретом ([`deploy/Caddyfile`](deploy/Caddyfile)).

## Установка

Проверки без Docker и аккаунтов, на Node.js 22 или новее (зависимостей в `package.json` нет):

```bash
npm run check         # check:build, validate и 48 тестов, те же шаги, что в CI
npm run build         # перегенерировать parameters.jsCode в workflows/*.json из src/
npm run validate      # scripts/validate.mjs по всем воркфлоу
npm test              # node --test "tests/**/*.test.mjs"
```

Для полного стека нужен Docker с Compose v2; по оценке из runbook, локальной модели по умолчанию нужно около 8 ГБ памяти, пока она отвечает:

```bash
git clone https://github.com/sinnercode228/n8n-home-ai-workflows.git home-automation
cd home-automation
cp .env.example .env                    # вписать N8N_ENCRYPTION_KEY: openssl rand -hex 32
mkdir -p documents logs backups
docker compose up -d                    # n8n и профили из COMPOSE_PROFILES (в примере ollama,qdrant)
docker compose logs -f ollama-models    # первый запуск: скачиваются nomic-embed-text и llama3.1:8b, потом сервис завершается
```

Открыть http://localhost:5678, создать owner-аккаунт и импортировать воркфлоу:

```bash
docker compose cp workflows n8n:/tmp/workflows
docker compose exec n8n n8n import:workflow --separate --input=/tmp/workflows
docker compose restart n8n
```

Дальше создать credentials, заполнить Config-ноды и активировать нужные воркфлоу. Execute workflow в редакторе — настоящий запуск, включая черновик в Gmail и сообщения в Telegram.

- Порт редактора опубликован только на `127.0.0.1`. Файловым нодам доступны только `/data/docs` (папка документов, смонтирована на чтение) и `/logs` (`N8N_RESTRICT_FILE_ACCESS_TO` в `docker-compose.yml`).
- Профиль `proxy` ставит перед редактором Caddy с HTTPS и basic auth на всё, кроме `/webhook/*`, `/webhook-test/*` и `/healthz`, и открывает порты 80 и 443.
- [`scripts/backup.sh`](scripts/backup.sh) выгружает воркфлоу и credentials (по-прежнему зашифрованные), потом останавливает n8n на несколько секунд снапшота тома (`scripts/backup.sh:32-39`); вебхук, пришедший в эти секунды, получит отказ. Восстановление описано в runbook.
- Если правите Code-ноду в редакторе n8n, перенесите правку в `src/` и запустите `npm run build`, иначе валидатор сообщит о расхождении.

## Известные ограничения

Найдено при чтении и запуске кода, пока не исправлено. Большую часть без живых аккаунтов толком не исправить и не проверить.

1. **Повторно присланный транскрипт создаёт дубли.** `meetingId` вычисляется (`src/meeting/normalize-transcript.js:80`), но нигде не проверяется, так что вторая доставка создаёт вторую страницу встречи и второй набор задач. Вебхук отвечает 202 до начала обработки, поэтому отправитель не узнаёт о сбое и может только прислать всё заново.
2. **Пустые даты в Notion не проверены.** Задача без срока отправляет `''` в `Due|date` (нода «Notion: Create Task» в `workflows/meeting-notes-to-notion.json`); встреча без времени начала отправляет `date: null` (`src/meeting/notion-content.js:24`). Валидация к тому же стирает невалидные и прошедшие сроки (`src/meeting/validate-notes.js:60-67`), так что задачи без срока будут часто. Что n8n-нода Notion делает с этими значениями, я не проверял.
3. **Владелец задачи подбирается по имени.** Если модель назвала владельца не точно как участника, побеждает первый участник с тем же первым словом (`src/meeting/validate-notes.js:19-26`), так что двух участников с одинаковым именем можно перепутать.
4. **Удалённые документы продолжают находиться.** Переиндексация удаляет старые чанки только по путям из текущего прогона (`src/docqa/chunk.js:66-70`). Файл, убранный из `documents/`, всплывает в ответах, пока коллекцию Qdrant не удалить руками.
5. **Упавший upsert оставляет дыру.** Qdrant: Delete Old Chunks выполняется раньше Qdrant: Upsert Points (`workflows/private-doc-qa-local-llm.json`). Если upsert упадёт, эти файлы выпадут из поиска до следующей успешной переиндексации.
6. **Длинный текст без пробелов молча обрезается.** Абзац длиннее `chunkChars` режется регуляркой, которой нужен пробельный символ не реже чем через `chunkChars - chunkOverlap` (1000) символов (`src/docqa/chunk.js:38`). Из более длинного участка без пробелов (длинный URL, base64, таблица без пробелов) остаются только последние 1000 символов: «word » + 3000 × «x» + « end» превращается в один чанк из 1012 символов. Я проверил это прямым вызовом `chunkDocument`; тестом это не покрыто.
7. **Только `.md` и `.txt`, по запросу на чанк.** `docsGlob` в Config-ноде — `/data/docs/**/*.{md,txt}`, а Extract From File работает в текстовом режиме, так что PDF и сканы не индексируются. Ollama: Embed Chunks шлёт отдельный запрос `/api/embed` на каждый чанк, и большая папка означает столько же запросов.
8. **Размерность векторов фиксируется при создании коллекции.** `embedDims: 768` соответствует `nomic-embed-text`, а коллекция создаётся, только если её нет (нода «Needs Collection?»). Смена модели эмбеддингов требует поменять число и удалить коллекцию руками. В тестах векторы 8-мерные (`tests/workflows.test.mjs:150`), так что 768 ничем не проверяется.
9. **Образы Ollama и Qdrant не запинены.** `OLLAMA_IMAGE_TAG=latest` и `QDRANT_IMAGE_TAG=latest` (`.env.example:6-7`), при том что n8n запинен на 2.40.6. Поиск идёт через `/points/search` Qdrant, и после нового `latest` его стоит перепроверить.
10. **Часовой пояс задаётся в трёх местах.** `TIMEZONE` в `.env` (передаётся как `GENERIC_TIMEZONE` в `docker-compose.yml`), `settings.timezone` в каждом JSON (по нему работают расписания; без него валидатор предупреждает, `scripts/validate.mjs:95`) и `timezone` в Config-нодах (окно дня для сводки, `src/calendar/day-window.js:27-34`). Если они разойдутся, сводка будет не за тот день.
11. **У проверки `local-only` есть слепые зоны.** Она смотрит на типы нод, URL HTTP-нод и URL в Config (`scripts/validate.mjs:263-278`), но не на тело Code-нод и не на URL, изменённые в редакторе после импорта. Поиск ключей в открытом виде — список регулярок (`scripts/validate.mjs:28-41`); ключ в другом формате пройдёт.
12. **У обработчика ошибок свои слепые зоны.** Дедупликация алертов хранит состояние в static data воркфлоу (`scripts/lib/code-nodes.mjs:203-208`), которое n8n сохраняет только между продакшн-запусками, так что при ручных прогонах алерт будет на каждую ошибку. Если упадёт сам обработчик (например, `./logs` недоступна на запись из контейнера), это видно только в Executions: своего error workflow у него нет по правилу валидатора (`scripts/validate.mjs:125-127`).

## Журнал проверок

- 2026-10-02, macOS, Node 25.8.2: `npm run check:build` → «Code nodes are in sync with src/.»; `npm run validate` → 4 воркфлоу, 0 ошибок, 0 предупреждений; `npm test` → 48 тестов, все прошли.
- CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) гоняет те же три шага на Node 22 и 24; на 24 ещё `docker compose config -q` со всеми тремя профилями и `bash -n scripts/backup.sh` (`.github/workflows/ci.yml:33-39`). Контейнеры в CI не поднимаются, `backup.sh` проверяется только на синтаксис.
- Скриншоты в `docs/screenshots/` — редактор n8n после импорта четырёх JSON.
- Не делалось ни разу: запросы из этих воркфлоу к api.anthropic.com, Notion, Google Calendar, Gmail, Telegram, Ollama и Qdrant.

## Структура репозитория

```
workflows/            четыре JSON для импорта в n8n
src/                  логика Code-нод как ES-модули
  shared/             json-repair, llm-response, backoff, redact, alert, text
  meeting/ calendar/ docqa/ errors/
scripts/
  build-workflows.mjs вставляет src/ в Code-ноды (--check для CI)
  validate.mjs        статический валидатор воркфлоу
  lib/code-nodes.mjs  карта «Code-нода -> модули + entry»
  backup.sh           бэкап: воркфлоу, зашифрованные credentials, том n8n
tests/                unit.test.mjs, workflows.test.mjs (vm), validator.test.mjs, harness.mjs
samples/              вебхуки, ответы API, демо-документы (всё выдуманное)
docs/                 architecture.md, runbook.md, screenshots/
deploy/Caddyfile      опциональный HTTPS + basic auth перед редактором
docker-compose.yml    n8n + Ollama + Qdrant (+ Caddy), healthchecks, тома
```

---

Автор — Грешный Котик ([@sinnercode228](https://github.com/sinnercode228) на GitHub), беру заказы на похожие задачи: Telegram [@sinnercode](https://t.me/sinnercode). Лицензия [MIT](LICENSE).
