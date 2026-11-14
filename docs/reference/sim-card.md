# SIM card and SIM PIN

> **Applies to:** RM520N-GL (EU edition) · AT replies checked on hardware 2026-11-11 (`CLCK`, `CRSM` EF_SPN, `CSCA`); `AT+QPINC` and the PIN writes not yet run on hardware

| Item | Value |
| --- | --- |
| Card | **System Settings → Security**, "SIM card" (`components/system-settings/security/sim-card.tsx`, `hooks/use-sim-card.ts`) |
| CGI | `cellular/sim_card.sh` — GET facts; POST `enable` / `disable` / `change` / `unlock` / `forget` |
| Saved PIN | `/etc/qmanager-secrets/sim_pin` (root 0600) through `qmanager_secret_set set|clear sim_pin`; `status` reports `sim_pin` and `sim_pin_failed` |
| Auto-unlock | `sim_pin_autounlock` in `qmanager_poller`, called from Tier 2 when `AT+CPIN?` says `SIM PIN` |

## Reads (GET)

- `AT+CLCK="SC",2` → PIN lock on/off. `AT+QPINC="SC"` → PIN and PUK attempts left. `AT+CPIN?` → `ready` / `pin` / `puk`.
- `AT+CRSM=176,28486,0,0,17` (EF_SPN) → operator name: the first byte is the display condition, the rest GSM 7-bit (printable ASCII kept), `FF` padding.
- `AT+CSCA?` → SMS centre.

## Writes (POST) — the rules that protect the SIM

- PINs are 4–8 digits, checked in the CGI and again in the helper.
- **No write when fewer than 2 PIN attempts are left, or when the count is unknown** (`AT+QPINC` failed): one wrong PIN would leave the SIM needing its PUK. PUK entry is not offered; the card tells the user to use a phone.
- Every PIN-carrying command runs with `QCMD_QUIET=1`, so a refused PIN is logged at DEBUG, not ERROR; at the default INFO level it never reaches the log. It is visible in `qcmd`'s argv for the length of one AT exchange.
- `enable` / `unlock` / `change` save the PIN when `remember` is not `false` (default on); `disable` and `forget` delete it. Saving a PIN removes the `sim_pin_failed` stop flag.

## Auto-unlock after a restart

- Runs only when a PIN is saved, `sim_pin_failed` does not exist, at least 2 attempts are left, and not more than once per 5 minutes.
- **One refusal stops it for good**: the poller writes `sim_pin_failed` and adds a `sim_change` warning event. A failover to a second SIM with a different PIN ends the same way, by design.
- Events: `sim_change` info "SIM card unlocked with the saved PIN" or warning "The saved SIM PIN was refused".
