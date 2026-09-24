#!/usr/bin/env bash
# Dumps every database to backups/erp-<timestamp>.archive.gz and keeps 14 days.
# Run from the repository root on the server (see docs/deploy-hostinger.md).
set -euo pipefail

ENV_FILE=${ENV_FILE:-.env.production}
KEEP_DAYS=${KEEP_DAYS:-14}
OUT_DIR=${OUT_DIR:-backups}

MONGO_ROOT_PASSWORD=$(grep '^MONGO_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
mkdir -p "$OUT_DIR"
file="$OUT_DIR/erp-$(date +%Y%m%d-%H%M).archive.gz"

docker compose --env-file "$ENV_FILE" exec -T mongo \
  mongodump --username root --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --archive --gzip --oplog > "$file"

find "$OUT_DIR" -name 'erp-*.archive.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup written: $file ($(du -h "$file" | cut -f1))"
