# Telegram commands

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device against a mock Bot API on BusyBox 1.31.1 (11 checks), not yet on hardware

| Item | Value |
|------|-------|
| Daemon | `scripts/usr/bin/qmanager_telegram_bot` (root; reads the bot token the Alerts page stored) |
| Unit | `qmanager-telegram-bot.service` — gated by `/etc/qmanager/telegram_alerts.json` `(.enabled == true) and (.commands == true)`, `MemoryLimit=16M` |
| Toggle | **Commands** on the Telegram tab of `/monitoring/alerts`; `alerts.sh` `save_settings` field `telegram.commands` (absent keeps the saved value) |
| State | `/tmp/qmanager_tgbot_offset`, `/tmp/qmanager_tgbot.json` |
| Commands | `/status`, `/signal`, `/ip`, `/data`, `/reboot` then `/reboot_confirm` within 60 s, `/help` (`/start`); `@BotName` suffixes are stripped |

- **Long poll:** `getUpdates?timeout=50`, one idle HTTPS request at a time; the token reaches curl on stdin (`-K -`), never argv. Offline → backoff 5 s doubling to 300 s.
- **Only the saved chat** is answered (numeric chat id; an `@channel` id disables commands), and only when it is a **private** chat whose sender is that same user (`chat.type == "private"` and `from.id == chat.id`). A group chat ID still receives alerts, but commands sent in a group are ignored: any member could otherwise send `/reboot`. Commands older than 120 s are ignored, and on start the backlog is skipped (`offset=-1`), so a queued `/reboot_confirm` can never fire after an outage. At most 10 commands a minute.
- The config and token are re-read on every loop: saving Alerts only has to start or stop the unit.
- `/reboot` writes a `telegram_command` network event before `sync; reboot`.
