# Settings Backup & Restore

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device on BusyBox 1.31.1, not yet on hardware

`/system-settings/backup` downloads QManager's settings as one `.tar.gz` and restores such a file.

| Item | Value |
|------|-------|
| CGI | `system/backup.sh` — GET download, POST `?action=inspect\|restore` with the raw file as the body (max 2 MB) |
| Hook | `hooks/use-settings-backup.ts` |
| Page | `components/system-settings/backup/backup.tsx` |
| Manifest | `qmanager-backup.json` — `{format: 1, app: "QManager", version, model, created, files}` |
| Helper | `qmanager_secret_set status x` (root, via sudo) — booleans for which secrets exist |

- **Allowlist only.** `ALLOW_FILES` plus the `profiles/` and `scenarios/` folders. Device-bound state (IMEI backup, SIM registry, boot ids, logs, `auth.json`) is never included; symlinks are skipped on download.
- **Secrets never travel.** Tokens and passwords live in `/etc/qmanager-secrets`. On restore each `*_set` marker (`discord_bot.json`, `telegram_alerts.json` `token_set`; `email_alerts.json` `app_password_set`) is set from what this device actually holds, and the response lists `secrets_missing`.
- **Validation before any write.** `gzip -t`; every `tar -tvf` line must be a regular file or directory with an allowlisted name and nothing after the name (rejects links, `..`, unknown folders); every JSON file (and `qmanager.conf`) must parse; the manifest must say `app: QManager, format: 1`. A failure changes nothing.
- **Writes** go through `<file>.restore.tmp` + `mv`; all reload flags are touched; the page then offers a reboot through the normal `/reboot/` hand-off.
