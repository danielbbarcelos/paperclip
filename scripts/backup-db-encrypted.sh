#!/usr/bin/env bash
set -euo pipefail

# Encrypted, off-volume Postgres backup for Paperclip deployments.
#
# Why this exists: the built-in `pnpm db:backup` writes plain gzip dumps next to
# the live database (same volume) and next to the secrets master key. A single
# ransomware/volume loss event then takes the data AND its backups. This script
# writes an AES-256 *encrypted* dump to a directory you point OFF that volume
# (ideally a different host / object store mount).
#
# Usage:
#   BACKUP_ENCRYPTION_PASSPHRASE=... \
#   BACKUP_DIR=/mnt/offsite/paperclip-backups \
#   DATABASE_URL=postgres://user:pass@host:5432/db \
#   ./scripts/backup-db-encrypted.sh
#
# In Docker Compose (dump runs inside the db container, file lands on the host):
#   BACKUP_ENCRYPTION_PASSPHRASE=... BACKUP_DIR=/mnt/offsite \
#   BACKUP_VIA_COMPOSE=1 ./scripts/backup-db-encrypted.sh
#
# Restore (manual, deliberate):
#   openssl enc -d -aes-256-cbc -pbkdf2 -salt \
#     -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in <file>.sql.gz.enc \
#     | gunzip | psql "$DATABASE_URL"
#
# Retention: keeps the most recent $BACKUP_RETENTION (default 14) encrypted dumps.

: "${BACKUP_ENCRYPTION_PASSPHRASE:?Set BACKUP_ENCRYPTION_PASSPHRASE (e.g. openssl rand -base64 32) and store it SEPARATELY from the backups}"
: "${BACKUP_DIR:?Set BACKUP_DIR to a path OFF the live data volume}"
BACKUP_RETENTION="${BACKUP_RETENTION:-14}"
BACKUP_VIA_COMPOSE="${BACKUP_VIA_COMPOSE:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/paperclip-${stamp}.sql.gz.enc"
tmp="${out}.partial"

cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

echo "Backing up to encrypted file: $out"

encrypt() {
  # AES-256-CBC with PBKDF2 + random salt. Output is unreadable without the passphrase.
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_PASSPHRASE
}

if [ "$BACKUP_VIA_COMPOSE" = "1" ]; then
  # Dump inside the db container; credentials come from the container env.
  ( cd "$PROJECT_ROOT" && docker compose -f docker/docker-compose.yml exec -T db \
      sh -c 'pg_dump -U "${POSTGRES_USER:-paperclip}" -d "${POSTGRES_DB:-paperclip}"' ) \
    | gzip -9 | encrypt > "$tmp"
else
  : "${DATABASE_URL:?Set DATABASE_URL or use BACKUP_VIA_COMPOSE=1}"
  pg_dump "$DATABASE_URL" | gzip -9 | encrypt > "$tmp"
fi

mv "$tmp" "$out"
trap - EXIT
chmod 600 "$out"
echo "Done: $(du -h "$out" | cut -f1) -> $out"

# Prune old encrypted dumps, keeping the newest $BACKUP_RETENTION.
mapfile -t old < <(ls -1t "$BACKUP_DIR"/paperclip-*.sql.gz.enc 2>/dev/null | tail -n +"$((BACKUP_RETENTION + 1))")
if [ "${#old[@]}" -gt 0 ]; then
  echo "Pruning ${#old[@]} old backup(s) beyond retention=$BACKUP_RETENTION"
  rm -f "${old[@]}"
fi
