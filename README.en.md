# n8n-home-ai-workflows

[Русский](README.md) · **English**

Four n8n workflows for a home server running Docker Compose: meeting notes into Notion via Claude, a morning digest of the family calendars, answers about household documents from a local Ollama, and a shared error handler. Compose runs n8n 2.40.6 for them, plus Ollama, Qdrant and Caddy via profiles. The Code nodes are built from modules in `src/`, and the tests run exactly what's in the JSON.

| Workflow | Trigger | What it does | Services, model |
|---|---|---|---|
| [`meeting-notes-to-notion`](workflows/meeting-notes-to-notion.json) | webhook `POST /webhook/meeting-notes` | transcript → Claude → JSON with a summary, decisions and tasks → a Notion page, tasks in Tasks, deadlines in Google Calendar | Claude Messages API, `claude-opus-5`; Notion; Google Calendar; Telegram |
| [`family-calendar-digest`](workflows/family-calendar-digest.json) | every day at 07:00 (`0 7 * * *`) | the day's events from the family calendars, without duplicates and with overlaps flagged → text from the LLM → a Gmail draft and a Telegram message | Google Calendar; `claude-opus-5` or Ollama `llama3.1:8b`; Gmail; Telegram |
| [`private-doc-qa-local-llm`](workflows/private-doc-qa-local-llm.json) | webhook `POST /webhook/doc-qa`; re-index at 02:30 (`30 2 * * *`) and manually | answers a question from the `.md` and `.txt` files in the documents folder, with citations to the sources | Ollama: `nomic-embed-text` (768 dimensions), `llama3.1:8b`; Qdrant |
| [`error-handler`](workflows/error-handler.json) | Error Trigger; the other three point to it in `settings.errorWorkflow` | an entry in `/logs/n8n-errors.jsonl` with keys and tokens masked, an alert in Telegram | Telegram |

The workflows pass the validator and the mock runs on `samples/`, but I haven't run them against live Anthropic, Notion, Google or Telegram accounts. Chunks of a file deleted from `documents/` stay in Qdrant. If the upsert fails after the old chunks were deleted, those files drop out of search until the next re-index. A transcript sent twice creates a second meeting page and a second set of tasks.

![The meeting-notes-to-notion workflow in the n8n editor, with the Plan Retry → Retry? → Wait (Backoff) loop at the bottom](docs/screenshots/meeting-notes-to-notion.png)

The other canvases: [calendar digest](docs/screenshots/family-calendar-digest.png), [document Q&A](docs/screenshots/private-doc-qa-local-llm.png), [error handler](docs/screenshots/error-handler.png).

## Why the logic doesn't live in the Code nodes

n8n stores a Code node's code as a string, `parameters.jsCode`, right in the workflow JSON. Here, all 18 of those strings are generated. The logic lives in `src/` as ES modules, and [`scripts/lib/code-nodes.mjs`](scripts/lib/code-nodes.mjs) describes which modules go into which node, plus a short `entry` per node. The entry is the only place that touches `$input`, `$('Node')` and `$runIndex`.

`npm run build` ([`scripts/build-workflows.mjs`](scripts/build-workflows.mjs)) follows relative imports, puts dependencies before the modules that depend on them, strips `import` and `export`, and fails on an import cycle. `npm run check:build` exits with code 1 if any workflow differs from the build output, and [`scripts/validate.mjs`](scripts/validate.mjs) compiles each Code node with `new vm.Script(...)` and compares it with what `src/` would produce. So a change made in the n8n editor has to be carried back into `src/` by hand.

The unit tests run the modules directly, and [`tests/harness.mjs`](tests/harness.mjs) pulls `jsCode` out of `workflows/*.json` and runs it with `vm.runInNewContext` and fake n8n variables. The Claude, Ollama, Google Calendar and Qdrant responses for these runs are in `samples/`.

## A custom retry loop for the Claude request

The error output of the `Claude: Extract Notes` node (`onError: continueErrorOutput`) leads to the `Plan Retry` Code node, then to the `Retry?` IF node and `Wait (Backoff)`, which sends the request back into the same HTTP node. In the screenshot, that's the bottom loop. The header comment in [`src/shared/backoff.js`](src/shared/backoff.js) explains why it exists:

> n8n's built-in "Retry On Fail" waits a fixed time (max 5 s) between tries. Rate limits (429) and overload (529) deserve real exponential backoff, and a 400/401 should not be retried at all - so the workflow loops through a Wait node using the plan computed here.

The loop retries 408, 409, 429, 500, 502, 503, 504, 529 and network errors with no status; anything else goes straight to Telegram as an alert. The attempt count isn't stored anywhere. The number of the failed attempt is `$runIndex + 1`, and n8n increments `$runIndex` by itself on every pass through the loop. The delay is random, between exp/2 and exp, where exp = min(300, 10 · 2^(n−1)) s, so with `maxAttempts: 4` from Config you get 5–10, 10–20 and 20–40 s, then an alert. The webhook responds with 202 right away (`responseMode: onReceived`), so the service that sent the transcript doesn't wait through the delays.

In the calendar digest, `Claude: Write Digest` uses the regular Retry On Fail (3 tries, 5 s apart). After those, [`digest.js`](src/calendar/digest.js) builds the digest from a template without the LLM.

The Claude request is built by [`src/meeting/claude-request.js`](src/meeting/claude-request.js): the notes JSON Schema in `output_config.format`, `output_config.effort: "medium"` and `fallbacks: "default"`. [`llm-response.js`](src/shared/llm-response.js) takes text only from `text` blocks and treats `stop_reason: refusal` or `max_tokens` as an error. In that case nothing is written to Notion and an alert goes out. With structured outputs, the JSON repair in [`json-repair.js`](src/shared/json-repair.js) never comes into play; it's kept in case a local model is used. Then [`validate-notes.js`](src/meeting/validate-notes.js) checks the JSON itself: without a `summary`, no page is created, while impossible dates like `2026-02-30`, due dates before the meeting and duplicate tasks are removed with a warning on the page.

## What data goes to Anthropic

The meeting transcript goes to Anthropic in full. For the calendar digest, Claude gets event titles, times, names and overlaps. Event locations and notes are only included in the request if Config has `sendLocationsToCloud: true`, and with `llmProvider: "ollama"` the local model gets everything. The `buildDigestRequest: privacy` unit test and a mock run of the `Build Digest Request` node check that the locations from the sample don't end up in the cloud request. The finished digest still goes to Gmail and Telegram.

The document Q&A workflow is tagged `local-only`. For workflows with that tag, [`scripts/validate.mjs`](scripts/validate.mjs) rejects cloud service nodes (16 patterns in `CLOUD_NODE_TYPES`), substitutes the Config values into every HTTP node's URL, and only lets through local hosts like `ollama`, `qdrant` and `host.docker.internal`. This check won't see a URL that was changed in the editor after import. When something fails, the node name and error text do still go to Telegram through the error handler; [`redact.js`](src/shared/redact.js) masks keys and tokens in the text.

## Clock changes, made-up citations and repeat alerts

- [`day-window.js`](src/calendar/day-window.js) finds the UTC instant of local midnight in two passes, because the offset changes on days when the clocks change. A test checks that November 1, 2026 in `America/New_York` is 25 hours long.
- [`rag.js`](src/docqa/rag.js) strips `[n]` citations to nonexistent sources from the answer; small local models sometimes make these up. If no chunk reaches the `minScore` of 0.35, the LLM isn't called and the webhook responds right away with `grounded: false`.
- The error handler sends the same alert at most once every 30 minutes. The fingerprint in [`error-record.js`](src/errors/error-record.js) is built from the workflow id, the node name and the message with numbers replaced by `#`. Errors with severity `high` (401, 403, credentials) always get through.

## Running it

You can check everything without Docker or any accounts, on Node.js ≥ 22; `package.json` has no dependencies. The mock runs take transcripts and the Alder family's calendars from `samples/`, with e-mail addresses on the reserved `home.example` domain.

```bash
npm run check    # check:build, validate and 48 tests, the same steps as in CI
```

The full stack:

```bash
cp .env.example .env                    # fill in N8N_ENCRYPTION_KEY: openssl rand -hex 32
mkdir -p documents logs backups
docker compose up -d                    # profiles from COMPOSE_PROFILES, ollama,qdrant in the example
docker compose cp workflows n8n:/tmp/workflows
docker compose exec n8n n8n import:workflow --separate --input=/tmp/workflows
docker compose restart n8n
docker compose logs -f ollama-models    # first run: the models are downloading
```

The editor opens at http://localhost:5678, and the port is published only on `127.0.0.1`. File nodes can access `/data/docs` (read-only) and `/logs`. The `proxy` profile puts Caddy in front of the editor, with basic auth on everything except webhooks and `/healthz`. After the import, check that the other three workflows have their error workflow set to Global error handler.

The quickest one to try is the document Q&A: it needs one credential, `Webhook shared secret (doc Q&A)` (Header Auth; the example uses the `X-Webhook-Secret` header), and no external accounts.

```bash
cp -r samples/docs/* documents/
# in the editor: run "Manual: Re-index Documents" and activate the workflow
curl -X POST http://localhost:5678/webhook/doc-qa \
  -H "X-Webhook-Secret: <secret>" -H "Content-Type: application/json" \
  -d '{"question": "When is the boiler service due?"}'
```

The other three need credentials with the names used in the nodes (Anthropic as Header Auth with `x-api-key`, Notion, Google, Telegram, the meeting webhook secret), your own values in place of the 9 `REPLACE_WITH_*` placeholders in the Config nodes, and the Notion databases Meetings (`Date`, `Source`, `Attendees`, `Recording`) and Tasks (`Owner`, `Due`, `Priority`, `Status`, `Meeting`). All four workflows are inactive in the repo.

On Apple Silicon, Docker doesn't use the GPU, so [`docker-compose.yml`](docker-compose.yml) recommends a native Ollama at `http://host.docker.internal:11434`. Backups and key rotation are covered in [`docs/runbook.md`](docs/runbook.md).

## Tests

| File | Tests | What they cover |
|---|---|---|
| [`tests/unit.test.mjs`](tests/unit.test.mjs) | 33 | modules from `src/`: backoff, LLM response parsing, JSON repair, notes validation, the day window, chunking, citations, error fingerprints |
| [`tests/workflows.test.mjs`](tests/workflows.test.mjs) | 8 | mock runs of the real `jsCode` of all four workflows, including 429 → retry and 401 → alert without a retry |
| [`tests/validator.test.mjs`](tests/validator.test.mjs) | 7 | all workflows pass, and broken copies get caught: a broken connection, a key in a header, a credential in the JSON, a webhook without auth, a cloud host in `local-only`, Code node drift, an error output without `continueErrorOutput` |

All 48 tests are written with `node:test`. CI repeats the `npm run check` steps on Node 22 and 24, and on 24 it also runs `docker compose config -q` with all profiles and `bash -n scripts/backup.sh`.

---

Built by Грешный Котик (sinnercode). I take freelance work like this: Telegram [@sinnercode](https://t.me/sinnercode). License: [MIT](LICENSE).
