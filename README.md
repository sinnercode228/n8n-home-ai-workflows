# n8n-home-ai-workflows

Четыре воркфлоу n8n для домашнего сервера на Docker Compose: заметки со встреч в Notion через Claude, утренняя сводка семейных календарей, ответы по домашним документам на локальной Ollama и общий обработчик ошибок. Compose поднимает для них n8n 2.40.6, а по профилям ещё Ollama, Qdrant и Caddy. Code-ноды собираются из модулей в `src/`, и тесты гоняют именно то, что лежит в JSON.

| Воркфлоу | Запуск | Что делает | Сервисы, модель |
|---|---|---|---|
| [`meeting-notes-to-notion`](workflows/meeting-notes-to-notion.json) | вебхук `POST /webhook/meeting-notes` | транскрипт → Claude → JSON с резюме, решениями и задачами → страница в Notion, задачи в Tasks, сроки в Google Calendar | Claude Messages API, `claude-opus-5`; Notion; Google Calendar; Telegram |
| [`family-calendar-digest`](workflows/family-calendar-digest.json) | каждый день в 07:00 (`0 7 * * *`) | события дня из календарей семьи без дублей, с отмеченными пересечениями → текст от LLM → черновик в Gmail и Telegram | Google Calendar; `claude-opus-5` или Ollama `llama3.1:8b`; Gmail; Telegram |
| [`private-doc-qa-local-llm`](workflows/private-doc-qa-local-llm.json) | вебхук `POST /webhook/doc-qa`; переиндексация в 02:30 (`30 2 * * *`) и вручную | ответ на вопрос по `.md` и `.txt` из папки документов со ссылками на источники | Ollama: `nomic-embed-text` (768 измерений), `llama3.1:8b`; Qdrant |
| [`error-handler`](workflows/error-handler.json) | Error Trigger; на него указывает `settings.errorWorkflow` трёх остальных | запись в `/logs/n8n-errors.jsonl` с маскировкой ключей и токенов, алерт в Telegram | Telegram |

Воркфлоу проходят валидатор и mock-прогоны на `samples/`, но с живыми аккаунтами Anthropic, Notion, Google и Telegram я их не запускал. Чанки файла, удалённого из `documents/`, остаются в Qdrant, упавший после удаления старых чанков upsert выключает эти файлы из поиска до следующей переиндексации, а повторно присланный транскрипт создаёт вторую страницу встречи и второй набор задач.

![Воркфлоу meeting-notes-to-notion в редакторе n8n, внизу петля Plan Retry → Retry? → Wait (Backoff)](docs/screenshots/meeting-notes-to-notion.png)

Остальные холсты: [сводка календарей](docs/screenshots/family-calendar-digest.png), [Q&A по документам](docs/screenshots/private-doc-qa-local-llm.png), [обработчик ошибок](docs/screenshots/error-handler.png).

## Почему логика не живёт в Code-нодах

n8n хранит код Code-ноды строкой `parameters.jsCode` прямо в JSON воркфлоу. Здесь все 18 таких строк сгенерированы. Логика лежит в `src/` как ES-модули, а [`scripts/lib/code-nodes.mjs`](scripts/lib/code-nodes.mjs) описывает, какие модули идут в какую ноду, плюс короткий `entry`, единственное место, которое обращается к `$input`, `$('Node')` и `$runIndex`.

`npm run build` ([`scripts/build-workflows.mjs`](scripts/build-workflows.mjs)) обходит относительные импорты, ставит зависимости раньше зависимых, вырезает `import` и `export` и падает на цикле импортов. `npm run check:build` выходит с кодом 1, если хоть один воркфлоу отличается от сборки, а [`scripts/validate.mjs`](scripts/validate.mjs) компилирует каждую Code-ноду через `new vm.Script(...)` и сравнивает её с тем, что получилось бы из `src/`. Поэтому правку из редактора n8n приходится руками переносить в `src/`.

Юнит-тесты гоняют модули напрямую, а [`tests/harness.mjs`](tests/harness.mjs) достаёт `jsCode` из `workflows/*.json` и выполняет его через `vm.runInNewContext` с поддельными переменными n8n. Ответы Claude, Ollama, Google Calendar и Qdrant для этих прогонов лежат в `samples/`.

## Своя петля повторов для запроса к Claude

Error-выход ноды `Claude: Extract Notes` (`onError: continueErrorOutput`) ведёт в Code-ноду `Plan Retry`, дальше IF `Retry?` и `Wait (Backoff)`, откуда запрос возвращается в ту же HTTP-ноду; на скриншоте это нижняя петля. Зачем она, написано в шапке [`src/shared/backoff.js`](src/shared/backoff.js):

> n8n's built-in "Retry On Fail" waits a fixed time (max 5 s) between tries. Rate limits (429) and overload (529) deserve real exponential backoff, and a 400/401 should not be retried at all - so the workflow loops through a Wait node using the plan computed here.

Повторяются 408, 409, 429, 500, 502, 503, 504, 529 и сетевые ошибки без статуса, остальное сразу уходит алертом в Telegram. Счётчик попыток нигде не хранится. Номер упавшей попытки равен `$runIndex + 1`, а `$runIndex` n8n сам увеличивает на каждом проходе петли. Пауза случайная, от exp/2 до exp, где exp = min(300, 10 · 2^(n−1)) с, так что при `maxAttempts: 4` из Config выходит 5–10, 10–20 и 20–40 с, потом алерт. Вебхук отвечает 202 сразу (`responseMode: onReceived`), и сервис, приславший транскрипт, пауз не ждёт.

В сводке календарей у `Claude: Write Digest` обычный Retry On Fail (3 попытки через 5 с), после них [`digest.js`](src/calendar/digest.js) собирает сводку по шаблону без LLM.

Запрос к Claude собирает [`src/meeting/claude-request.js`](src/meeting/claude-request.js): JSON Schema заметок в `output_config.format`, `output_config.effort: "medium"` и `fallbacks: "default"`. [`llm-response.js`](src/shared/llm-response.js) берёт текст только из блоков `text` и считает ошибкой `stop_reason: refusal` или `max_tokens`; тогда в Notion ничего не пишется и уходит алерт. При structured outputs до починки JSON в [`json-repair.js`](src/shared/json-repair.js) дело не доходит, она оставлена на случай локальной модели. Потом [`validate-notes.js`](src/meeting/validate-notes.js) проверяет сам JSON: без `summary` страница не создаётся, а несуществующая дата вроде `2026-02-30`, срок раньше встречи и дубли задач снимаются с предупреждением на странице.

## Какие данные уходят в Anthropic

Транскрипт встречи уходит в Anthropic целиком. В сводке календарей Claude получает названия событий, время, имена и пересечения. Места и заметки к событиям попадают в запрос, только если в Config стоит `sendLocationsToCloud: true`, а с `llmProvider: "ollama"` локальная модель получает всё. Юнит-тест `buildDigestRequest: privacy` и mock-прогон ноды `Build Digest Request` проверяют, что места из примера в облачный запрос не попадают. Готовая сводка всё равно уходит в Gmail и Telegram.

Q&A по документам помечен тегом `local-only`. Для таких воркфлоу [`scripts/validate.mjs`](scripts/validate.mjs) отклоняет ноды облачных сервисов (16 шаблонов в `CLOUD_NODE_TYPES`), подставляет в URL каждой HTTP-ноды значения из Config и пропускает только локальные хосты вроде `ollama`, `qdrant` и `host.docker.internal`. URL, поменянный в редакторе после импорта, эта проверка не увидит. При сбое имя ноды и текст ошибки всё же уходят в Telegram через error-handler, ключи и токены в тексте маскирует [`redact.js`](src/shared/redact.js).

## Перевод часов, выдуманные сноски и повторные алерты

- [`day-window.js`](src/calendar/day-window.js) ищет UTC-момент локальной полуночи в два прохода, потому что в дни перевода часов смещение меняется. Тест проверяет, что 1 ноября 2026 года в `America/New_York` длится 25 часов.
- [`rag.js`](src/docqa/rag.js) вырезает из ответа ссылки `[n]` на несуществующие источники, которые маленькие локальные модели иногда придумывают. Если ни один фрагмент не набрал `minScore` 0.35, LLM не вызывается и вебхук сразу отвечает с `grounded: false`.
- Error-handler шлёт один и тот же алерт не чаще раза в 30 минут. Отпечаток в [`error-record.js`](src/errors/error-record.js) строится из id воркфлоу, имени ноды и сообщения с числами, заменёнными на `#`. Ошибки severity `high` (401, 403, credentials) приходят всегда.

## Запуск

Без Docker и аккаунтов всё проверяется на Node.js ≥ 22, зависимостей в `package.json` нет. Mock-прогоны берут из `samples/` транскрипты и календари семьи Alder с почтой на зарезервированном домене `home.example`.

```bash
npm run check    # check:build, validate и 48 тестов, те же шаги, что в CI
```

Полный стек:

```bash
cp .env.example .env                    # вписать N8N_ENCRYPTION_KEY: openssl rand -hex 32
mkdir -p documents logs backups
docker compose up -d                    # профили из COMPOSE_PROFILES, в примере ollama,qdrant
docker compose cp workflows n8n:/tmp/workflows
docker compose exec n8n n8n import:workflow --separate --input=/tmp/workflows
docker compose restart n8n
docker compose logs -f ollama-models    # первый запуск: скачиваются модели
```

Редактор открывается на http://localhost:5678, порт опубликован только на `127.0.0.1`. Файловым нодам доступны `/data/docs` (на чтение) и `/logs`. Профиль `proxy` ставит перед редактором Caddy с basic auth на всё, кроме вебхуков и `/healthz`. После импорта стоит проверить, что у трёх воркфлоу error workflow указывает на Global error handler.

Быстрее всего проверить Q&A по документам: ему нужен один credential `Webhook shared secret (doc Q&A)` (Header Auth, в примере заголовок `X-Webhook-Secret`) и никаких внешних аккаунтов.

```bash
cp -r samples/docs/* documents/
# в редакторе: запустить «Manual: Re-index Documents» и активировать воркфлоу
curl -X POST http://localhost:5678/webhook/doc-qa \
  -H "X-Webhook-Secret: <секрет>" -H "Content-Type: application/json" \
  -d '{"question": "When is the boiler service due?"}'
```

Остальным трём нужны credentials с именами из нод (Anthropic как Header Auth с `x-api-key`, Notion, Google, Telegram, секрет вебхука встреч), свои значения вместо 9 заглушек `REPLACE_WITH_*` в Config-нодах и базы Notion Meetings (`Date`, `Source`, `Attendees`, `Recording`) и Tasks (`Owner`, `Due`, `Priority`, `Status`, `Meeting`). В репозитории все четыре воркфлоу выключены.

На Apple Silicon Docker не использует GPU, поэтому [`docker-compose.yml`](docker-compose.yml) советует нативную Ollama на `http://host.docker.internal:11434`. Бэкапы и ротация ключей описаны в [`docs/runbook.md`](docs/runbook.md).

## Тесты

| Файл | Тестов | Что проверяют |
|---|---|---|
| [`tests/unit.test.mjs`](tests/unit.test.mjs) | 33 | модули из `src/`: бэкофф, разбор ответов LLM, починка JSON, валидация заметок, окно дня, чанки, цитаты, отпечатки ошибок |
| [`tests/workflows.test.mjs`](tests/workflows.test.mjs) | 8 | mock-прогоны настоящего `jsCode` всех четырёх воркфлоу, в том числе 429 → повтор и 401 → алерт без повтора |
| [`tests/validator.test.mjs`](tests/validator.test.mjs) | 7 | все воркфлоу проходят, испорченные копии ловятся: битая связь, ключ в заголовке, credential в JSON, вебхук без авторизации, облачный хост в `local-only`, дрейф Code-ноды, error-выход без `continueErrorOutput` |

Все 48 тестов написаны на `node:test`. CI повторяет шаги `npm run check` на Node 22 и 24, а на 24 ещё `docker compose config -q` со всеми профилями и `bash -n scripts/backup.sh`.

Лицензия: [MIT](LICENSE).
