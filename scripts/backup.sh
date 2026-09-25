#!/usr/bin/env bash
# Nightly backup of the home automation stack. Safe to run by hand.
#
#   ./scripts/backup.sh               # writes backups/<timestamp>/
#   KEEP_DAYS=60 ./scripts/backup.sh  # keep more history
#
# What is saved:
#   workflows/    one JSON file per workflow (n8n export, readable, diff-able)
#   credentials/  n8n credential export - still ENCRYPTED with N8N_ENCRYPTION_KEY,
#                 so it is useless without the key (keep the key in a password manager)
#   n8n_data.tgz  the whole n8n volume (database, settings) for a full restore
# Not saved: Ollama models (re-download) and Qdrant vectors (re-index from documents).
#
# Schedule it with cron / launchd, e.g. `crontab -e`:
#   15 3 * * * cd /Users/you/home-automation && ./scripts/backup.sh >> logs/backup.log 2>&1

set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="backups/${STAMP}"
PROJECT="$(docker compose config --format json | sed -n 's/^ *"name": "\(.*\)",$/\1/p' | head -1)"
PROJECT="${PROJECT:-home-automation}"

mkdir -p "${DEST}"
echo "[backup] exporting workflows and credentials -> ${DEST}"
docker compose exec -T n8n n8n export:workflow --backup --output="/backups/${STAMP}/workflows/"
docker compose exec -T n8n n8n export:credentials --backup --output="/backups/${STAMP}/credentials/"

echo "[backup] snapshotting the n8n volume (n8n pauses for a few seconds)"
docker compose stop n8n
trap 'docker compose start n8n >/dev/null' EXIT
docker run --rm \
  -v "${PROJECT}_n8n_data:/data:ro" \
  -v "$(pwd)/${DEST}:/out" \
  alpine:3 tar czf /out/n8n_data.tgz -C /data .
docker compose start n8n
trap - EXIT

echo "[backup] removing backups older than ${KEEP_DAYS} days"
find backups -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"${KEEP_DAYS}" -print -exec rm -r {} +

echo "[backup] done: ${DEST} ($(du -sh "${DEST}" | cut -f1))"
echo "[backup] reminder: copy backups/ off this machine (external drive or cloud folder)."
