# Operator and SIM check

> **Applies to:** RM520N-EU / RM520N-GL · CGI tested off-device (BusyBox sh, stub `qcmd`, local echo server); SIM table verified against one Telia LT SIM read on hardware

Card on `/system-settings/security` (`OperatorCard` in `security-check.tsx`, hook `use-operator-audit.ts`).

| Item | Value |
|------|-------|
| CGI | `system/operator_audit.sh` — GET reads the SIM, POST `header_test` |
| SIM read | `AT+CRSM=176,28472,0,0,0` (EF_UST `6F38`, READ BINARY). Service *n* is bit *n-1* of the table (3GPP TS 31.102 §4.2.8) |
| Services used | 28 data download via SMS-PP (`sms_download`), 29 SMS-CB, 30 call control, 31 MO-SMS control, 122 5GS mobility info (`sa_ready`), 124 subscription identifier privacy (`id_privacy`), 125 SUCI calculated in the USIM |
| Header test | One GET to `http://httpbin.org/headers`, then `http://postman-echo.com/headers`; `QM_ECHO_URLS` overrides |

- **Read-only.** Nothing is written to the SIM. A SIM that refuses the read (status word not `144,0`) or an AT failure returns `sim.readable: false`.
- **`id_privacy` false** means the phone uses the null scheme: the subscriber number is not concealed on standalone 5G. Only a new SIM from the operator changes it.
- **Header verdicts**, first match wins: `identity` (a name matching the known enrichment list), `proxy` (`Via`, `Forwarded`, `X-Forwarded-For`…), `modified` (the `User-Agent` that arrived is not the one sent), `unexpected`, `clean`. Headers the echo services' own load balancers add are in `EXPECTED`.
- **Names only.** The response carries header names, cut to 60 characters and 20 entries, never values: a value can be the phone number itself.
- The request leaves over the cellular interface from the modem itself; in IP Passthrough the router's traffic uses the same connection.
