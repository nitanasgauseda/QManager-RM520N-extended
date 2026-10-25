# QManager RM520N — EU edition

Everything this edition adds to or changes in the original **QManager RM520N v0.1.17** by dr-dolomite (https://github.com/dr-dolomite/QManager-RM520N). Base commit: `a8249a3`.

Install: copy `qmanager.tar.gz` to the modem, then `cd /tmp && tar xzf qmanager.tar.gz && cd qmanager_install && sh install_rm520n.sh`.

## ✨ New Features

- **Telegram alerts.** **Monitoring → Alerts** has a fourth channel: paste a bot token from @BotFather and your chat ID, and connection-restored and reboot alerts arrive in Telegram, with a test button like the other channels. (The token is stored root-only beside the Discord token and reaches `curl` on stdin, never on its command line; like email and Discord, Telegram cannot send while the internet is down.)
- **Firmware update check.** **About Device** has a new Firmware update card that shows the installed build and its GL/EU variant, checks a firmware package name before you flash it (wrong variant, older, same or newer), and lists the QFirehose steps for flashing from a computer over USB. (The modem cannot flash itself: it reboots into download mode and QManager goes offline with it.)
- **Tower Map.** **Cellular → Cellular Information → Tower Map** shows your serving tower on a map or satellite view, how far it is, the distance the modem itself measures, and the true and compass direction to aim an antenna. Tap the map to set your location and drag the tower onto its real mast; corrections stay on the modem. (Tower positions come from OpenCelliD, CC BY-SA 4.0: a mirror checked by sha256, or, with your own free OpenCelliD key entered on the page, OpenCelliD's daily export, refreshed weekly when you open the page.)
- **Cell Guard.** A new **Monitoring → Cell Guard** page warns when the modem connects to a cell that behaves like a fake base station: a drop to 3G, a cell never seen here and not in the tower database, a known cell reporting a new area code, or a "far" tower the timing advance places next door. Warnings appear in Network Events and can be sent by SMS, email, Telegram or Discord (**Suspicious cell** in **Monitoring → Alerts**). The first 24 hours learn your usual cells.
- **Optional Rayhunter.** From Cell Guard you can download EFF's Rayhunter (pinned v0.13.0, sha256-verified) for signalling-level checks such as IMSI requests and forced 2G downgrades; its warnings join Cell Guard's. It needs the modem's Qualcomm diagnostic interface, which the page checks for. (Runs as an off-by-default service; its port is closed to everything but the modem itself.)
- **Signal History.** **Monitoring → Connection Quality → Signal History** charts signal strength, signal quality, traffic and modem temperature over 24 hours, 7 or 30 days, recorded every minute and kept on the modem. (About 100 KB a day under `/usrdata`, written to flash every 15 minutes; nothing is recorded before the clock is set.)
- **Best cells advisor.** The same page ranks every cell the modem used by its average signal quality and, when one averaged 3 dB or more better than the cell you are on, suggests locking to it with links to Band and Tower Locking.
- **Data plan tracking.** **Monitoring → Data Plan & Temperature** counts this billing period's traffic against your plan size, shows when it resets, and warns at 80 or 90 % and at 100 % by SMS, email, Telegram or Discord (**Data plan limit** in **Monitoring → Alerts**). Enter what your operator shows once to line the count up.
- **Temperature alert.** The same page warns when the modem stays at or above your limit (75 °C by default) and logs when it cools down again.
- **Settings backup and restore.** **System Settings → Backup & Restore** downloads all QManager settings as one small file and restores it after a reset or on another modem, showing what is in the file first. Passwords and bot tokens are never put in the file; the page tells you which to enter again.
- **Scanned towers on the Tower Map.** The last **Cell Scanner** sweep now appears on **Tower Map** as a list of every operator's towers around you, located on the map, with distance and direction; **Aim** draws the line to point an antenna at any of them.
- **DNS Privacy.** **Local Network → DNS Privacy** encrypts the DNS lookups of every device on your network (DNS over TLS to Quad9, Cloudflare, Mullvad, AdGuard, Google, NextDNS or your own resolver), so your operator cannot read which sites you visit. Pick AdGuard to also filter ads at the provider. (A small forwarder on `/usrdata` that runs only while encryption is on. It catches every DNS lookup from your network, even from a router set to use the operator's DNS; dnsmasq is never restarted, and if the forwarder stops or its answers do not reach your devices, the modem gives them the carrier's DNS back within two minutes.)
- **Silent SMS detection.** Cell Guard now checks incoming SMS every 5 minutes and warns about silent (type 0) messages, flash messages, messages addressed to the SIM card itself and configuration pushes, which are used to locate or reconfigure a device without its owner noticing. Turn it off with **Check incoming SMS** on **Monitoring → Cell Guard**. (Some modems discard type 0 messages before storing them; those cannot be seen.)
- **Security Check.** **System Settings → Security Check** shows which services on the modem the internet can reach over IPv4 and IPv6, closes any of them with one click, and points out USB debugging (ADB), Cell Guard and encrypted DNS settings worth a look. Closing a port affects only the cellular side.
- **Activity Log.** **System Settings → Activity Log** lists every sign-in, failed password and settings change with its time and address, and **Monitoring → Alerts** can now send a message for each sign-in (**Sign-ins to QManager**, off by default). (The newest 500 entries are kept; request contents and passwords are never recorded.)
- **Telegram commands.** Turn on **Commands** on the Telegram tab of **Monitoring → Alerts** and send `/status`, `/signal`, `/ip`, `/data` or `/reboot` to your bot to get answers from the modem. Only your saved chat is answered, and a reboot asks you to confirm. (One idle request to Telegram every 50 seconds; old commands sent while the modem was offline are ignored.)
- **SIM change and roaming alerts.** QManager tells you when the SIM card is changed or pulled out, and when the modem starts roaming on a foreign network; **Monitoring → Data Plan & Temperature → Roaming** can also block your devices' data until it is back home. (Roaming is read from the network registration every 2 minutes; calls and SMS keep working while data is blocked.)
- **Public IP and carrier NAT.** **System Settings → Security Check** shows the address the internet sees and whether your operator shares it with other customers, and can alert you when it changes. (Asks api.ipify.org every 30 minutes; turn it off on the same card.)
- **Outages.** **Monitoring → Connection Quality → Outages** shows how often the internet dropped over 7, 30 or 90 days, the availability, the worst hours of the day and the cells the modem was on at the time.
- **Monthly report.** On the first day of each month a summary arrives by email, Telegram or Discord: data used, outages, average signal and the main cell (**Monthly report** in **Monitoring → Alerts**).
- **Resources.** **Monitoring → Resources** shows processor and memory use, flash space and the programs using the most of them, updated every 5 seconds.
- **Lithuanian APN presets.** Telia, Bitė and Tele2 (voice and data-only SIMs) are now in the operator list on **APN Settings** and **Custom SIM Profiles**.
- **Hide the modem from internet scans.** A new **Cellular-side privacy** card in **System Settings → Security** stops the modem answering ping and closed-port probes from the cellular side, so scanners see nothing. Your router, its traffic and VPNs such as NetBird are not affected. (Drops inbound echo-request and outbound unreachable/RST on `rmnet+`, IPv4 and IPv6; NDP left alone.)
- **Turn IPv6 off for your network.** The same card can stop the router and devices behind the modem getting IPv6, so they use IPv4 only; the modem keeps its own IPv6. (Blocks IPv6 forwarding, router advertisements and DHCPv6 on the LAN bridge; re-applied after a re-dial.)
- **eSIM profiles.** New **Cellular → Settings → eSIM** page: see the EID, switch, rename and delete profiles, and download a new one with the operator's activation code. Needs an eSIM chip or a removable eSIM card in the SIM slot; a regular SIM shows "No eSIM found". (lpac v2.3.0 over AT+CCHO/CGLA with an AT+CSIM fallback.)

## 🛠️ Improvements

- **The web page loads faster.** Pages, scripts and styles are sent compressed and cached by the browser, so QManager opens several times faster over Wi-Fi. (lighttpd `mod_deflate` with a cache on `/usrdata`, enabled only if the installer's config test passes.)
- **Less work while nobody is looking.** The background poller asks the modem about four times less often while no QManager page is open, and goes back to full speed as soon as one is.
- **Less wear on the flash.** The Data Used counter is kept in memory and saved to flash every 5 minutes instead of every few seconds.

## 🐛 Fixes

- **Traffic Engine no longer cuts the internet in IP Passthrough mode.** With **Local Network → Traffic Engine** on, devices behind a router in IP Passthrough lost every web page while the modem itself stayed online; the engine now listens on, and redirects to, the modem's LAN address. (tpws bound to, and REDIRECT rewrote to, the carrier IP that the router also uses.)
- **The QManager page is no longer reachable over the carrier's IPv6.** The firewall that limits the web page to your own network now covers IPv6 as well as IPv4; before, a modem with a public IPv6 address served the sign-in page to the internet.
- **Cell Guard no longer asks you to turn Rayhunter on when it cannot run.** On a modem without the Qualcomm diagnostic interface, the misleading "Turn Rayhunter on to see its warnings" line is gone.

## 📦 Third-party software

- **lpac v2.3.0** (AGPL-3.0, estkme-group) for eSIM, shipped as a static ARMv7 build with a one-line fix to its stdio driver; source and patch notes in `dependencies/NOTICE` and `dependencies/lpac-stdio.patch`.
- **Rayhunter v0.13.0** (EFF) is downloaded only on request and verified by sha256; it is not bundled.
- OpenCelliD tower data is downloaded with your own API key; no data is bundled.

## License

Same as the original: MIT + Commons Clause. lpac keeps its own AGPL-3.0 license.
