# SplycedBoard

A hub of Savant integrations that runs on the Savant Pro Host (macOS). Each integration
bridges one outside system into Savant through a Savant component profile, and each can be
switched on or off from a web dashboard without restarting anything.

| Integration | What it does | Savant profile | Docs |
|---|---|---|---|
| **Lutron LEAP** | HomeWorks QSX / RadioRA 3 lighting, shades, keypads, scenes and Palladiom thermostats | `profiles/lutron_leap bridge.xml` | [docs/lutron.md](docs/lutron.md) |
| **Apple TV** | IP control of any number of Apple TVs (Companion protocol, PIN pairing, no HomeKit) | `profiles/apple_apple tv (splycedboard).xml` | [docs/appletv.md](docs/appletv.md) |
| **SCLI Bridge** | Lets other devices read/write Savant state and send service requests via `sclibridge` | `profiles/ip_requests.xml` | [docs/scli.md](docs/scli.md) |

And **tools** for commissioning, on the dashboard under Tools:

| Tool | What it does | Docs |
|---|---|---|
| **Samsung TV** | Finds Samsung TVs, gets the AccessToken Savant needs (Allow on the TV), and works any Samsung TV like a remote, 2010 models to today's | [docs/tv-tools.md](docs/tv-tools.md) |
| **LG TV** | Finds LG TVs, shows how to get the IP control keycode and checks it, and works the TV like a remote | [docs/tv-tools.md](docs/tv-tools.md#lg-tv) |
| **Sony TV** | Finds BRAVIA TVs, checks the Pre-Shared Key (Savant's profiles send 1234), and works the TV like a remote | [docs/tv-tools.md](docs/tv-tools.md#sony-tv) |

The tools list the TVs in the Blueprint configuration the host runs, with the key Blueprint has
for each, and warn when one is missing.

This folder is everything a Pro Host needs, and one Terminal command downloads and installs it;
see [Install](#install).

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

On the Pro Host, open Terminal (in Applications › Utilities) and paste:

```bash
cd "$(mktemp -d)" && curl -fsSLO https://github.com/wirm/splycedboard/releases/latest/download/SplycedBoard.tar.gz && tar -xzf SplycedBoard.tar.gz && ./SplycedBoard/install
```

That downloads the latest release of this folder from GitHub and opens its installer.

Maybe you already have the folder: you downloaded `SplycedBoard.zip` from the
[latest release](https://github.com/wirm/splycedboard/releases/latest) in a browser, or copied the
folder over with AirDrop, USB or `scp -r`. Then run its installer through Terminal: type `bash`
and a space, drag `install` from the folder into the Terminal window, and press Return.

> **Don't double-click `install`.** It isn't signed with an Apple Developer ID. If it came from a
> browser download or AirDrop, macOS won't open it from Finder, and since macOS 15, Control-click ›
> Open no longer gets around that. Both ways above avoid the check. The Terminal line downloads
> with `curl`, which doesn't flag files as downloaded. `bash install` has bash read the script
> rather than macOS opening it.

The installer opens a few macOS dialogs:

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

> **macOS 15 and later: allow local network access.** The first time SplycedBoard reaches
> for a device on the network, such as a scan for a Lutron processor or an Apple TV, macOS
> asks on the Pro Host's screen whether **bun** may find and connect to devices on the local
> network. Click **Allow**. If the question was missed or declined, switch **bun** (or
> **node**) on under **System Settings → Privacy & Security → Local Network**. Without it,
> scans find nothing, and pairing and connections fail with "No route to host".

> **Why a link on the Desktop instead of a folder?** macOS doesn't let background services read
> from `~/Desktop` without a Full Disk Access grant, and a service without that grant can fail
> silently after a reboot. So the real files live in Application Support, and the Desktop
> gets a link to them. Open it in Finder like any folder.

Options: `./install --headless` asks in the terminal instead (automatic over SSH);
`./install --yes` takes the defaults without asking (unattended updates).

### Update

The dashboard checks GitHub for a new release twice a day, and shows **Update available** at
the top when there is one. **Settings → Updates** has **Check now** and **Update to vX**.
Updating downloads the release, checks it against the SHA-256 checksum GitHub publishes, and
runs its installer, the same way as the Terminal line. Integrations pause for about a minute,
then the dashboard reloads on the new version. The installer's output is in
`logs/update.log`.

The Terminal line from [Install](#install) works too: paste it again to get the latest release.
So does running the installer from any newer copy, through Terminal as described there.

Either way, settings, pairing and integration choices are kept, and dependencies are only
re-downloaded when `package.json` changed. After an update, check the Overview for Savant
profiles that need updating in Blueprint too (see
[Connecting an integration to Savant](#connecting-an-integration-to-savant)).

### What's in ~/Desktop/SplycedBoard

```
Open Dashboard.webloc   double-click to open the dashboard
profiles/               Savant component profiles, one per integration
docs/                   setup guides: Lutron, Apple TV, SCLI Bridge, the TV tools
scripts/                start · stop · restart · status · logs · dev · uninstall
data/                   settings, Lutron certificates, Apple TV pairings (back this up)
logs/                   splycedboard.log (rotates at 5 MB, keeps 3), update.log (the last update)
install, src/, public/  the app itself
```

---

## Dashboard

- **Overview**: every integration with a live status, an on/off switch, its ports, and a
  download button for its Savant profile. Switching one off closes its ports and APIs
  immediately. Savant loses control of that system until it's switched back on. A yellow
  note appears when Savant runs a different version of an integration's profile than this
  SplycedBoard ships.
- **One page per integration**: Lutron has discovery, pairing, loads, rooms (which Savant
  Blueprint zones each Lutron area's lights go in, for the Blueprint lighting export),
  thermostats, keypads and scenes. Apple TV has pairing, a card per Apple TV, and a remote with an app
  launcher.
  The SCLI Bridge has status and a command runner.
- **Tools**: Samsung TV, LG TV and Sony TV. Scan for TVs, get or check each one's key for
  Blueprint, see the TVs in the running configuration (with a warning when a key is missing), and
  work any of them like a remote, from the keyboard too.
- **Logs**: live log view, filterable by integration, level and text, with a download
  button.
- **Settings**: service info, restart, updates, verbose logging, folders, and all Savant
  profiles, each with the version it ships and the version Savant reports running.

## Connecting an integration to Savant

1. Download the integration's profile from the dashboard on the Mac that runs Blueprint. It
   comes as a zip holding a folder with the profile inside, so a second download numbers the
   folder, never the file. You can also take it from `profiles/`. Add it to your profile
   library in Blueprint's Preferences. On older Blueprint, copy it into
   `~/Library/Application Support/RacePointMedia/systemConfig.rpmConfig/componentProfiles/`
   and restart Blueprint. **Keep the file name.** Blueprint finds a profile by its
   `<manufacturer>_<model>` file name, so a renamed copy (even `… (1).xml`) gives "Component
   not found".
2. Add the component in Blueprint and set its address to `127.0.0.1`. SplycedBoard runs on
   the Pro Host itself. HTTP profiles use port `47200`.
3. Fill in the data tables using the IDs shown on the integration's dashboard page, then
   upload the configuration.

### Profile versions

The Lutron (from 1.12) and Apple TV (from 1.2) profiles tell SplycedBoard which version of
themselves Savant is running, when Savant starts and every minute after. The dashboard
compares that with the version this SplycedBoard ships, and shows a yellow note on the
integration's Overview card when they differ.

- **Older in Savant**: add the new profile to Blueprint's library, update the component
  in the configuration, and upload it to the host.
- **Newer in Savant**: update SplycedBoard.
- **Older than 1.12 (or 1.2)**: Savant kept calling the integration for two minutes without
  reporting a version. The profile predates version reporting, so it's older: update it as
  above.

**Settings → Savant profiles** lists each component Savant reported, and the version it runs.
Nothing listed means nothing has reached SplycedBoard from Savant yet. Check that the
configuration with the component is running on the host, and that the component's address is
`127.0.0.1`, port `47200`. With **Verbose logging** on, the Logs page shows each report as it
arrives. Requests from Savant that fail are logged too, verbose or not.

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
(Companion) and 5353/UDP (discovery). The TV tools reach TVs on their own ports (Samsung 1516,
1515, 8001/8002, 55000; LG 9761; Sony 80), SSDP 1900/UDP and Wake-on-LAN; see
[docs/tv-tools.md](docs/tv-tools.md#ports).

The dashboard and ports have no authentication, so anything on the LAN can reach them. That
includes switching integrations off, and starting an update, though only ever to the latest
official release. Keep the Pro Host on a trusted network.

---

## Where things live

| What | Where |
|---|---|
| Code | `~/Library/Application Support/SplycedBoard` (link: `~/Desktop/SplycedBoard`) |
| Settings | `…/SplycedBoard/data/hub.json`, `…/data/<integration>/settings.json` |
| Lutron certificates | `…/SplycedBoard/data/lutron/certs/` |
| Apple TV pairings | `…/SplycedBoard/data/appletv/settings.json` |
| TV tools' TVs and keys | `…/SplycedBoard/data/samsungtv/`, `lgtv/`, `sonytv/` `settings.json` |
| Logs | `…/SplycedBoard/logs/splycedboard.log` (+ `launchd.log` for crash output, `update.log` for the last update) |
| launchd agent | `~/Library/LaunchAgents/com.splycedboard.hub.plist` |
