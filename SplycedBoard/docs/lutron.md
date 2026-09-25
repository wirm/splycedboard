# Lutron LEAP

Connects Savant to a Lutron **HomeWorks QSX** or **RadioRA 3** processor over LEAP, Lutron's
JSON-over-TLS protocol. It replaces the official Savant LEAP bridge (LCB-LEINT-00).

| Device | Support |
|---|---|
| HomeWorks QSX | Full: dimmers, switches, shades, fans, Ketra, Rania, keypads, scenes, Palladiom thermostats |
| RadioRA 3 | Full: same LEAP protocol |
| Caséta (Smart Bridge Pro 2) | Partial: pairing may differ; mDNS discovery works |
| RadioRA 2 | Not supported: different telnet protocol (use the HomeworksQS profile directly) |

---

## Pairing with the processor

Pairing exchanges certificates with the processor. It's done once. The certificates are stored
in `~/Desktop/SplycedBoard/data/lutron/certs/`; back that folder up.

**Upgrading from the standalone Savant Lutron Bridge?** The installer carries the existing
pairing over, so you don't need to pair again.

### Before you start

In **HomeWorks Designer** (QSX) or **RA3 Setup**:
- make sure **LEAP integration** is enabled on the processor
- QSX: create a "Pairing" button on a keypad, or use the pairing feature under processor settings
- RA3: find the physical pairing button on the processor

### Steps

1. Open the dashboard (`http://<pro-host-ip>:47200`) → **Lutron LEAP** → **Setup**.
2. Click **Scan Network**. Processors found over mDNS appear as clickable items. If yours
   doesn't show up (VLANs and managed switches often block mDNS), use **Manual Entry**.
3. Select the processor and click **Pair Now**. SplycedBoard connects and waits; the
   dashboard counts down.
4. **Within 3 minutes**, put the processor into pairing mode. On HomeWorks QSX, press the keypad
   button programmed for pairing, or use Designer's pairing feature; the processor has no
   pairing button of its own. On RA3 and Caséta, press the pairing button on the processor or
   bridge. The processor stays silent until then, and pairing mode turned on *before* Pair Now
   may not count.
5. On success SplycedBoard connects and loads the inventory, and the status turns green.
   Clicking **Pair Now** again during the wait starts over.

---

## Blueprint setup

### Install the profile

Download it from the dashboard on the Mac that runs Blueprint. It comes as a zip: open it
and you get a folder, such as `lutron_leap bridge 1.14`, with `lutron_leap bridge.xml` inside.
Downloading again numbers the folder, never the file. You can also take
`profiles/lutron_leap bridge.xml` straight from SplycedBoard's folder.

Add the file to your profile library in Blueprint's Preferences, replacing the old one. On
older Blueprint, copy it into Blueprint's profile folder instead and restart Blueprint:

```
~/Library/Application Support/RacePointMedia/systemConfig.rpmConfig/componentProfiles/
```

Keep the file name `lutron_leap bridge.xml` exactly. Blueprint finds a profile by its
`<manufacturer>_<model>` file name. A renamed copy, even `… (1).xml` from a browser's second
download, gives "Component not found" when you add the device and "Can't replace profile" when
you update one.

From version 1.12, the profile reports its version to SplycedBoard. The dashboard's Overview
warns when Savant runs a different version than SplycedBoard ships. Configurations still on
1.11 or earlier show as a profile that "doesn't report its version". Add the new profile to
Blueprint's library, update the Lutron LEAP Bridge component to it, and upload the
configuration.

### Add the device

1. Place a new **Lutron LEAP Bridge** device.
2. Connection: **Address** `127.0.0.1`, **Port** `47200`. The profile talks HTTP to
   SplycedBoard on the Pro Host.
3. No username or password is needed; SplycedBoard handles authentication with the processor.

### Feedback: levels changed outside Savant

Savant shows each load's level wherever it was changed: in Savant, at a keypad, in the Lutron
app, by a scene, or on SplycedBoard's dashboard. This needs profile 1.13 or later.

- **How it works.** HTTP can't push, so the profile asks SplycedBoard twice a second what
  changed.
- **Where levels go.** Each level is written into the state the data table row shows, such
  as `DimmerLevel_486`.
- **At startup.** Savant asks for each load's level once when it starts, and SplycedBoard
  resends every level every ten minutes.
- **Checking it.** The **Savant feedback** chip on the Setup tab shows which Savant host is
  asking. "not polling" means Savant is still running an older profile: update the
  component to 1.13 or later and upload the configuration.
- **What's covered.** Dimmer, Switch, Variable Shade and Shade rows, and the brightness of
  Color Slider rows.
- **Not yet covered.** Keypad LEDs, and the color or color temperature of Ketra and Rania
  loads (DMX and CCT Slider rows).

### Lighting data table

**Address1 = LEAP Zone ID.** Every zone's ID is shown on the **Loads** tab. They're stable
integers assigned by the processor, not the addresses from Designer's device list.

The **⬇ Export** button on the Loads and Rooms tabs downloads a ready-made
`lighting_export.plist` for Blueprint's lighting table. Each row's **Controller** is your
Lutron component's name in Blueprint, for example "Lighting Controller". SplycedBoard reads it
from the configuration Savant runs on the host: the component that uses the LEAP Bridge
profile. The Setup tab shows the name it found. A name typed in **Blueprint Component Name**
wins; clear it to go back to Blueprint's.

### Rooms: Lutron Areas → Savant Blueprint Zones

Each light in the export goes in a Savant zone, so Blueprint doesn't need them assigned by
hand. The **Rooms** tab has one row per zone: the **Savant Blueprint Zone** in gold, and the
**Lutron Areas** in it in blue.

1. **Get Savant's zones.** **Read zones from Savant** reads them from the configuration Savant
   runs on the Pro Host (`userConfig.rpmConfig`). If that isn't there, it asks
   `sclibridge userzones`. You can also type them in with **Edit zone list**, spelled as in
   Blueprint, for example before the configuration is on the host.
2. **Clear matches go in by themselves** when the area's name is unique. Their chips are
   dashed. A clear match is one of these:
   - the same name;
   - the same words, ignoring "room", abbreviations and Master/Primary/Owner's ("Living Room" →
     Living, "Mstr Bath" → Master Bathroom);
   - one name part of the other ("Kitchen Island" → Kitchen);
   - a one-letter slip ("Kitchn" → Kitchen).
3. **Click a zone's Lutron side to choose what's in it.** A window shows Lutron's whole tree
   of areas and their lights:
   - Tick whole areas, or single lights. The search box finds either.
   - Each area is tagged: **in this zone**, **in *another zone*** (you can still add it
     here), or **suggested**.
   - **Automatic** goes back to the clear matches.

   A light can be in several zones, for a pendant that shows in both Kitchen and Dining.
   Your choices are kept, across reconnects too.
4. **Areas in no zone are listed underneath**, with **Add to** the likeliest zone, **Add to…**
   any zone, or **Leave out** to export an area under its Lutron name and stop asking. These
   areas wait for you:
   - areas that share a name, like a "Bathroom" in every suite;
   - close calls and weak matches;
   - areas taken out of a zone.

   Lutron's hierarchy picks each suggestion: *Upstairs › Guest Suite › Bathroom* → Guest Bath.
   **Review** walks through them one at a time, showing where each area sits and which lights
   it has.

Areas still waiting when you export go out under their Lutron names, and the export asks
first.

| Load | Entity | Address1 |
|---|---|---|
| Dimmer | `Dimmer` | Zone ID |
| Switch | `Switch` | Zone ID |
| Ketra | `DMX` (RGBW) or `Color Slider` | Zone ID |
| Rania / tunable white | `DMX` (CCT) or `CCT Slider` | Zone ID |
| Fan | `Fan` | Zone ID |
| Area (all loads in a room) | `AreaDimmer` | Area ID |

Keypads and scenes:

| Data table column | Keypad button | Scene |
|---|---|---|
| Entity | `Keypad Button` | `Button Press And Release` |
| Address1 | Device ID (Keypads tab) | Virtual button ID (Scenes tab) |
| Address2 | Button number | — |
| Address3 | LED ID (usually the button number) | — |

### Shade data table

| Column | Value |
|---|---|
| Entity | `Variable Shade` or `Shade` |
| Address1 | Zone ID (Loads tab) |

### Thermostats

Palladiom thermostats use the HVAC controller resource with **Address1 = thermostat zone ID**
(shown on the Thermostats tab).

### State variables

| Variable | Default | Description |
|---|---|---|
| `SystemType` | `QSX` | Informational: `QSX` or `RA3` |
| `FadeTime` | `1` | Fade time in seconds for switch on/off actions |

---

## HTTP API (what the profile calls)

All on port 47200. The profile calls these without the `/lutron` segment, for example
`/api/zone/level`. SplycedBoard answers on both paths, so existing Blueprint configurations
keep working unchanged.

| Endpoint | Purpose |
|---|---|
| `GET /api/lutron/feedback` | The levels that changed since this Savant host last asked, 32 at a time: `{"z0":"486","l0":55, …}`, or `{}`. PollFeedback asks twice a second (from 1.13) |
| `GET /api/lutron/zone/query?id=` | `{ "zone": "486", "level": 55 }`, asked once per load when Savant starts (QueryDimmerLevel) |
| `GET /api/lutron/zone/level?id=&level=` | Set a zone (0–100) |
| `GET /api/lutron/zone/raise\|lower\|stop?id=` | Raise / lower / stop |
| `GET /api/lutron/area/level?id=&level=` | Set every load in an area |
| `GET /api/lutron/shade/level?id=&level=` · `shade/raise\|lower\|stop` | Shades |
| `GET /api/lutron/scene/recall?id=` | Recall a virtual button |
| `GET /api/lutron/button?device=&num=&action=` | `press`, `release`, `hold`, `pressrelease` |
| `GET /api/lutron/color?id=&level=&r=&g=&b=&w=` | Ketra color; with color values, `level=0` keeps the current brightness |
| `GET /api/lutron/cct?id=&level=` | Color temperature: 0 → 1400 K … 100 → 10000 K |
| `GET /api/lutron/hvac/status?id=` | Thermostat state for the profile |
| `GET /api/lutron/hvac/heat\|cool?id=&setpoint=` · `hvac/mode\|fan?id=&mode=` | Thermostat control |
| `GET /api/hub/profile-report?integration=lutron&version=` | ReportProfileVersion (from 1.12): the profile version Savant runs, at startup and every minute |

Fade and delay values are accepted but not yet sent to the processor.

## Telnet bridge (port 8023)

Speaks the HomeWorks QS integration protocol, for TCP profiles or anything that wants push
feedback.

| Command (→ SplycedBoard) | |
|---|---|
| `#OUTPUT,{id},1,{level}` | Set zone level |
| `#OUTPUT,{id},2` / `3` / `4` | Raise / lower / stop |
| `#SHADEGRP,{id},1,{level}` / `2` / `3` / `4` | Shade level / raise / lower / stop |
| `#AREA,{id},1,{level}` | Area level (falls back to a zone with that ID) |
| `#DEVICE,{device},{button},3` / `4` | Keypad button press / release |
| `#VIRTUALBUTTON,{id},3` | Recall scene |
| `#COLORSET,{id},1,{level},{R},{G},{B},{W}` | Ketra color |
| `#COLORTEMP,{id},1,{0-100}` | Color temperature |
| `?OUTPUT,{id}` / `?SHADEGRP,{id}` | Query level |

| Feedback (→ Savant) | |
|---|---|
| `~OUTPUT,{id},1,{level}.` | Dimmer/switch level changed (also sent for every zone on connect) |
| `~SHADEGRP,{id},1,{level}.` | Shade level changed |
| `~DEVICE,{device},{button},09,{00\|01}` | Keypad LED changed |
| `~COLORSET,…` / `~COLORTEMP,…` | Acknowledges a color command |

---

## Troubleshooting

**Processor not found by the scan.** The scan asks for Lutron's mDNS (Bonjour) announcements.
When that finds nothing, it checks every address on the Pro Host's own /24 for the two LEAP
ports (8083 and 8081). mDNS can be blocked by VLANs, managed switches or firewalls, and the
direct check only covers the host's own subnet. Otherwise, use **Manual Entry**, and check the
processor answers `ping`.

**"macOS isn't letting SplycedBoard reach devices on the local network."** macOS 15 and
later ask before a program talks to local devices. On the Pro Host, open **System Settings →
Privacy & Security → Local Network** and switch on **bun** (or **node**), then scan again.
Until then, pairing and the LEAP connection fail too, typically with "No route to host".

**"The processor didn't go into pairing mode within 3 minutes."** The connection worked, but
the processor never said pairing was allowed.
- Turn pairing mode on *after* clicking Pair Now, while the dashboard counts down.
- On QSX, check that the keypad button is programmed for pairing in Designer, and that the
  Designer project with it has been transferred to the processor.
- LEAP must be enabled (and on some QSX firmware, licensed) in HomeWorks Designer.
- The Logs page (filter: Lutron LEAP) shows every message the processor sent during pairing.

**Pairing fails with "Connection error".** Port 8083 must be reachable from the Pro Host:
`nc -zv <processor-ip> 8083`. On macOS 15 and later, also check the Local Network setting
(below).

**"Pairing rejected by processor".** Pairing mode wasn't active, the processor has too many
paired clients, or LEAP is disabled or unlicensed.

**Connected but no zones.** Check that zones are assigned in Designer, and look for LEAP error
responses on the dashboard's **Logs** page (filter: Lutron LEAP).

**Savant doesn't respond or shows no feedback.**
1. Check the dashboard: Lutron LEAP should be green ("Connected to …").
2. Blueprint's address should be `127.0.0.1`, port `47200`.
3. On the Logs page, turn on **Verbose logging** in Settings and trigger a command from Savant.
   You should see `→ setLevel zone …` lines.
4. Address1 in the data table must match the zone ID on the Loads tab.
5. For levels changed outside Savant, the **Savant feedback** chip on the Setup tab should
   show the Pro Host's address. If it says "not polling", Savant runs a profile older than
   1.13: update the component and upload the configuration.

**Certificates missing.** The pairing record exists but its certificate files don't (for
example, the `data/` folder was partly copied). Pair again from the Setup tab.
