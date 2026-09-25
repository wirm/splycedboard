# SplycedBoard

A hub of Savant integrations that runs on the Savant Pro Host (macOS). Each integration
bridges one outside system into Savant through a Savant component profile, and each can be
switched on or off from a web dashboard without restarting anything.

| Integration | What it does | Savant profile | Docs |
|---|---|---|---|
| **Lutron LEAP** | HomeWorks QSX / RadioRA 3 lighting, shades, keypads, scenes and Palladiom thermostats | `profiles/lutron_leap_bridge.xml` | [docs/lutron.md](docs/lutron.md) |
| **Apple TV** | IP control of any number of Apple TVs (Companion protocol, PIN pairing, no HomeKit) | `profiles/apple_tv_ip.xml` | [docs/appletv.md](docs/appletv.md) |
| **SCLI Bridge** | Lets other devices read/write Savant state and send service requests via `sclibridge` | `profiles/ip_requests.xml` | [docs/scli.md](docs/scli.md) |

This folder is everything a Pro Host needs — copy it over and run `./install`.

---

## How it works

```
                   Savant Pro Host (Mac)
 ┌──────────────────────────────────────────────────────────────┐
 │  Savant (Blueprint config)                                    │
 │    ├─ Lutron LEAP Bridge profile ─── HTTP 47200 /api/lutron ─┐│
 │    ├─ Apple TV (SplycedBoard) × N ── HTTP 47200 /api/appletv ┤│
 │    └─ IP Requests profile ────────── TCP 12001 ──────────────┤│
 │                                                              ▼│
 │  SplycedBoard  (launchd agent, one process)                   │
 │    ├─ dashboard + hub API ............ http://…:47200         │
 │    ├─ Lutron LEAP ── LEAP/TLS 8081 ─────────► Lutron QSX / RA3
 │    │    └─ HomeWorks-style telnet ...... TCP 8023             │
 │    ├─ Apple TV ──── Companion 49153 ────────► each Apple TV (by IP)
 │    └─ SCLI Bridge ── sclibridge ────────────► Savant state
 │         └─ client commands ............. TCP/HTTP 12000      │
 └──────────────────────────────────────────────────────────────┘
```

Savant only speaks plain TCP and HTTP to its component profiles. SplycedBoard does the
protocol work — TLS, pairing, discovery, JSON, subscriptions — and presents each system to
Savant in a form its profile understands. Everything runs locally on the Pro Host with no
cloud dependency.

---

## Install

Copy this folder to the Pro Host (AirDrop, USB, `scp -r`), open Terminal in it and run:

```bash
./install
```

(You can also double-click `install` in Finder.) The installer opens a few macOS dialogs:

1. **Install / Update** confirmation
2. **Which integrations** to switch on (changeable later on the dashboard)
3. **Copy Savant profiles to Blueprint**, if Blueprint's profile folder is on this Mac

Then it:

- installs [Bun](https://bun.sh) if neither Bun nor Node.js 18+ is present
- copies SplycedBoard to `~/Library/Application Support/SplycedBoard` and puts a
  **SplycedBoard** link on the Desktop
- installs dependencies and registers a launchd agent (`com.splycedboard.hub`) that starts at
  login and restarts SplycedBoard whenever it exits
- replaces the old standalone *Savant Lutron Bridge* service if present, carrying its
  processor pairing over, so there's no need to re-pair

When it's done, open the dashboard at **http://localhost:47200** (or `http://<pro-host-ip>:47200`
from another device).

> **Why a link on the Desktop instead of a folder?** macOS doesn't let background services read
> from `~/Desktop` without a Full Disk Access grant, and a service without that grant can fail
> silently after a reboot. So the real files live in Application Support, and the Desktop
> gets a link to them. Open it in Finder like any folder.

Options: `./install --headless` asks in the terminal instead (automatic over SSH);
`./install --yes` takes the defaults without asking (unattended updates).

### Update

Re-run `./install` from the newer copy. Settings, pairing and integration choices are kept.
Dependencies are only re-downloaded when `package.json` changed.

### What's in ~/Desktop/SplycedBoard

```
Open Dashboard.webloc   double-click to open the dashboard
profiles/               Savant component profiles, one per integration
docs/                   setup guides: Lutron, Apple TV, SCLI Bridge
scripts/                start · stop · restart · status · logs · dev · uninstall
data/                   settings, Lutron certificates, Apple TV pairings (back this up)
logs/                   splycedboard.log (rotates at 5 MB, keeps 3)
install, src/, public/  the app itself
```

---

## Dashboard

- **Overview**: every integration with a live status, an on/off switch, its ports, and a
  download button for its Savant profile. Switching one off closes its ports and APIs
  immediately. Savant loses control of that system until it's switched back on.
- **One page per integration**: Lutron has discovery, pairing, loads, thermostats, keypads
  and scenes. Apple TV has pairing, a card per Apple TV, and a remote with an app launcher.
  The SCLI Bridge has status and a command runner.
- **Logs**: live log view, filterable by integration, level and text, with a download
  button.
- **Settings**: service info, restart, verbose logging, folders, and all Savant profiles.

## Connecting an integration to Savant

1. Download the integration's profile (dashboard or `profiles/`) and copy it into
   `~/Library/Application Support/RacePointMedia/systemConfig.rpmConfig/componentProfiles/`
   on the Mac that runs Blueprint. Restart Blueprint.
2. Add the component in Blueprint and set its address to `127.0.0.1`. SplycedBoard runs on
   the Pro Host itself. HTTP profiles use port `47200`.
3. Fill in the data tables using the IDs shown on the integration's dashboard page, then
   upload the configuration.

---

## Managing the service

```bash
~/Desktop/SplycedBoard/scripts/status     # running? what is each integration doing?
~/Desktop/SplycedBoard/scripts/logs       # follow the log (add "errors" for warnings/errors only)
~/Desktop/SplycedBoard/scripts/restart
~/Desktop/SplycedBoard/scripts/stop       # until next login or scripts/start
~/Desktop/SplycedBoard/scripts/start
~/Desktop/SplycedBoard/scripts/uninstall  # asks whether to keep settings and pairing
~/Desktop/SplycedBoard/scripts/dev        # run in the foreground with live output (troubleshooting)
```

The scripts can also be double-clicked in Finder. `scripts/dev` offers to stop the background
service first, because both need the same ports.

## Ports

| Port | Used by | |
|---|---|---|
| 47200 | Hub | Dashboard, hub API, and HTTP endpoints for Savant profiles (`/api/<integration>/…`) |
| 8023 | Lutron LEAP | HomeWorks QS–style telnet with push feedback |
| 12000 | SCLI Bridge | Client commands (TCP or HTTP GET) |
| 12001 | SCLI Bridge | Savant host's persistent connection (IP Requests profile) |

Outgoing: Lutron processors on 8081 (LEAP) and 8083 (pairing); Apple TVs on 49153
(Companion) and 5353/UDP (discovery).

The dashboard and ports have no authentication, so anything on the LAN can reach them.
Keep the Pro Host on a trusted network.

---

## Where things live

| What | Where |
|---|---|
| Code | `~/Library/Application Support/SplycedBoard` (link: `~/Desktop/SplycedBoard`) |
| Settings | `…/SplycedBoard/data/hub.json`, `…/data/<integration>/settings.json` |
| Lutron certificates | `…/SplycedBoard/data/lutron/certs/` |
| Apple TV pairings | `…/SplycedBoard/data/appletv/settings.json` |
| Logs | `…/SplycedBoard/logs/splycedboard.log` (+ `launchd.log` for crash output) |
| launchd agent | `~/Library/LaunchAgents/com.splycedboard.hub.plist` |
