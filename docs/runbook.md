# Household runbook

Plain-language instructions for the home automation box. You don't need to be technical, but you do need to be able to copy and paste into Terminal.

> Demo project. Names such as "the Alder family" are fictional. Replace the paths and names with your own.

**Where everything lives:** the Mac mini in the office, folder `~/home-automation`.
**Open n8n:** http://localhost:5678 on the Mac mini (or your Caddy / Tailscale address).
**Passwords and keys:** in the family password manager, entry "Home automation".

---

## 1. Is it working?

Signs that everything is fine:

- A Telegram message with the family calendar arrives around **07:00** each morning.
- After a recorded meeting, a new page appears in Notion → **Meetings** within a few minutes.
- There were no Telegram messages titled "... needs attention".

To check it yourself, open Terminal and run:

```bash
cd ~/home-automation
docker compose ps
```

Every line should say `running` or `healthy`. If one says `unhealthy`, `exited` or `restarting`, go to section 2.

---

## 2. Restart everything

This fixes most problems.

```bash
cd ~/home-automation
docker compose restart
```

Wait 1 minute, then run `docker compose ps` again.

If that didn't help, do a full stop and start:

```bash
docker compose down
docker compose up -d
```

`down` does **not** delete your data. Workflows, credentials and history are kept in Docker volumes. Never add `-v` to `down`: that flag deletes the volumes.

**After a power cut or Mac restart:** Docker Desktop has to be running. It starts at login if "Start Docker Desktop when you sign in" is enabled in its settings. The containers then start by themselves (`restart: unless-stopped`).

**If you use the native Ollama app instead of the Docker one,** check that the llama icon is in the menu bar. If it isn't, open Ollama from Applications.

---

## 3. When something fails

Alerts arrive in Telegram with a **"What to do"** line. The most common ones:

| The alert says | What it means | What to do |
|---|---|---|
| *A key or login has expired or been revoked* | An API key or Google login stopped working | Section 5. Rotate or reconnect that credential |
| *The AI service is busy or rate-limited* | Anthropic returned 429 or 529. The workflow already retried with increasing waits | Usually nothing. If it repeats all day, check usage limits at console.anthropic.com |
| *A service could not be reached* | The Mac mini lost internet, or a container is down | Section 2. Restart everything |
| *The local AI (Ollama) did not answer* | Ollama is stopped or still loading a model | Section 2. The first question after a restart can take about 30 seconds |
| *Notion rejected the request* | The Notion database was renamed or moved, or is no longer shared with the integration | In Notion, open the database → `...` → Connections → add the integration again |
| *Claude declined the request* | The safety check refused this transcript, and the fallback model refused it too | Read the transcript in the n8n run. Nothing is lost. Add the notes by hand |

**Is anything lost?** No. Every run, including its input (the transcript, the calendar data), is saved in n8n for 14 days.

**To retry a failed run:**

1. Open n8n → **Executions** (left sidebar).
2. Click the red (failed) run.
3. Click **Retry** → *Retry with currently saved workflow*.

**Full error history:** `logs/n8n-errors.jsonl` has one line per error. Repeated alerts for the same problem are muted for 30 minutes, but every error is still logged.

---

## 4. Backups

`scripts/backup.sh` makes a backup. Schedule it once to run every night at 03:15 (the `crontab` line is at the top of the script; check it is there with `crontab -l`). It saves:

- all workflows (readable JSON)
- all credentials, **still encrypted**, so they are useless without the encryption key
- a full copy of n8n's database

They go to `~/home-automation/backups/<date>/`. Backups older than 30 days are removed.

**Keep a copy off the Mac.** Once a week, copy the `backups` folder to the external drive or a cloud folder. A backup that only exists on the same disk doesn't protect you from a dead disk.

Run a backup by hand (for example, before an update):

```bash
cd ~/home-automation
./scripts/backup.sh
```

### Restore after a disk failure or new machine

1. Install Docker Desktop and copy the `home-automation` folder, including `.env`, to the new machine.
2. Check that `N8N_ENCRYPTION_KEY` in `.env` is **the same one as before** (from the password manager).
3. Restore the database copy, then start:

```bash
cd ~/home-automation
docker compose up -d n8n && docker compose stop n8n        # creates the empty volume
docker run --rm -v home-automation_n8n_data:/data -v "$PWD/backups/<date>":/in alpine:3 \
  sh -c "rm -rf /data/* && tar xzf /in/n8n_data.tgz -C /data && chown -R 1000:1000 /data"
docker compose up -d
```

4. Document search: open the **Private document Q&A** workflow and click **Execute workflow** on "Manual: Re-index Documents". The vectors are rebuilt from your documents. They are not backed up because they can always be rebuilt.

---

## 5. Rotating API keys

Rotate a key when it may have leaked (for example, pasted into a chat or on a lost laptop), when someone with access leaves, or once a year.

**General steps:** make the new key → paste it into n8n → test → delete the old key.

In n8n: left sidebar → **Credentials** → click the credential → paste the new value → **Save**. The workflows pick it up immediately. You don't need to edit them.

| Credential in n8n | Where to get a new one | Delete the old one at |
|---|---|---|
| *Anthropic API key (x-api-key header)*. Header name `x-api-key`, value = the key | console.anthropic.com → API Keys → Create key | Same page → disable/delete the old key |
| *Notion (household workspace)* | notion.so/my-integrations → your integration → Refresh secret | The refresh replaces it |
| *Telegram bot (household alerts)* | Telegram → @BotFather → `/revoke` → choose the bot → copy the new token | `/revoke` does it |
| *Google Calendar (household)* / *Gmail (household)* | In n8n click **Reconnect** / **Sign in with Google** | myaccount.google.com → Security → Third-party connections |
| *Webhook shared secret (...)* | Make a new random value: `openssl rand -hex 24` | Update the meeting recorder / shortcut that calls the webhook, **then** save in n8n |

**Test after rotating:** open the workflow → **Executions** → pick a recent successful run → **Retry**. You can also wait for the next 07:00 digest.

### The encryption key (`N8N_ENCRYPTION_KEY`)

This key locks every credential stored in n8n.

- **Never change it** in `.env` on a working system. n8n would no longer be able to read any saved credential.
- **Never lose it.** Keep it in the password manager. Without it, a backup's credentials can't be restored, and every key has to be entered again.
- **If it leaked:** rotate every API key in the table above. The old encrypted values are then worthless.

---

## 6. Updating n8n

Updates are manual on purpose, so nothing changes by surprise.

1. Run a backup (section 4).
2. Read the n8n release notes for breaking changes.
3. Change `N8N_VERSION` in `.env` to the new version, then:

```bash
docker compose pull n8n
docker compose up -d n8n
```

4. Open n8n and check that the workflows still open, then run each one once with **Execute workflow**.
5. **Rollback:** put the old `N8N_VERSION` back in `.env` and run `docker compose up -d n8n`. If the database was upgraded, restore the backup from step 1.

---

## 7. Everyday changes

- **Add documents for Q&A.** Put `.md` or `.txt` files in `~/home-automation/documents/`. They are indexed every night at 02:30. For immediate indexing, run "Manual: Re-index Documents".
- **Add or remove a calendar from the digest.** Open *Family calendar digest* → **Config** node → edit the `calendars` list → Save.
- **Change the digest time.** Open the *Every Day 07:00* node and edit the cron expression. `0 7 * * *` means 07:00 every day, and `30 6 * * 1-5` means 06:30 on weekdays.
- **Keep calendar details off the cloud.** In the digest **Config**, set `"llmProvider": "ollama"`.
- **Pause a workflow.** Turn off the **Active / Published** switch at the top of the workflow.

---

## 8. Costs (rough)

- **Anthropic API:** billed per use. With the default model (`claude-opus-5`, $5 / $25 per million input / output tokens), a 30-minute meeting transcript (about 6-8k tokens) typically costs about 5-15 cents to summarise. The daily digest costs about a cent. Lower the `anthropicEffort` in Config, or pick a cheaper model, to spend less. Set a monthly spend limit at console.anthropic.com → Billing.
- **Ollama and Qdrant:** free, but they use the Mac's memory. The default local model needs about 8 GB of RAM while it is answering.
- **Notion, Google, Telegram:** free tiers are enough for a household.
