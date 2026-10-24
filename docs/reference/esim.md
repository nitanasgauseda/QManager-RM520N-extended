# eSIM (lpac)

> **Applies to:** RM520N-GL · needs an eUICC in the SIM slot (built-in chip or a removable eSIM card). A regular SIM reports `no_euicc`.

| Item | Value |
|------|-------|
| Page | `/cellular/settings/esim` — `components/cellular/settings/esim/esim.tsx`, `hooks/use-esim.ts` |
| CGI | `cellular/esim.sh` — GET `[?refresh=1]` → `{available, state, job}`; POST `refresh`, `enable`, `disable`, `delete`, `nickname {name}`, `download {code, confirm}`, `notify` |
| Bridge | `/usrdata/qmanager/bin/qmanager_esim` (Go, `esim/`) — runs lpac with `LPAC_APDU=stdio LPAC_HTTP=stdio` |
| lpac | `/usrdata/qmanager/bin/qmanager_lpac` — lpac v2.3.0, static ARMv7 musl, `dependencies/lpac-stdio.patch` (AGPL, see `dependencies/NOTICE`) |
| State | `/tmp/qmanager_esim_state.json` (EID, free memory, profiles), `/tmp/qmanager_esim_job.json` (download), `/tmp/qmanager_esim.lock`, `/tmp/qmanager_esim_channels` |

- APDUs go through `qcmd`, one AT command each, so the poller keeps running between them: `AT+CCHO`/`AT+CGLA`/`AT+CCHC` first; if `AT+CCHO` fails, `AT+CSIM` with MANAGE CHANNEL + SELECT. Both fail → `no_euicc`.
- Opened channels are recorded in `/tmp/qmanager_esim_channels` and closed at the next run's connect, so a crash cannot leak the SIM's few logical channels.
- HTTPS to the SM-DP+ is done by the bridge (Go `net/http`), certificate check off as in lpac's own curl driver: SM-DP+ servers use GSMA CI certificates, and the eUICC authenticates the server itself.
- Activation and confirmation codes travel on stdin (never argv) and are never logged; the audit log records only the action.
- One operation at a time (`flock -n` on the lock). Download runs detached with `-status` progress; the page polls GET every 2 s while `job.running`. After a successful download the CGI runs `notify` (`notification process -a -r`) and re-reads the profiles.
- Enable/disable pass refresh flag 1, so the eUICC asks the modem to re-read the SIM; the connection drops for a few seconds.
- lpac v2.3.0's stdio APDU driver inverted the `json_request()` success check and never worked; the patch fixes only that. Newer lpac loads drivers with `dlopen`, which a static binary cannot.
