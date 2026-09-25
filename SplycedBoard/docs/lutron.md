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
3. Select the processor and click **Pair Now**.
4. **Within 30 seconds**, press the pairing button (or enable pairing mode in Designer).
5. On success SplycedBoard connects and loads the inventory, and the status turns green.

---

## Blueprint setup

### Install the profile

Download it from the dashboard (or take `profiles/lutron_leap_bridge.xml`) and copy it into
Blueprint's profile folder on the Mac that runs Blueprint:

```
~/Library/Application Support/RacePointMedia/systemConfig.rpmConfig/componentProfiles/
```

Restart Blueprint.

### Add the device

1. Place a new **Lutron LEAP Bridge** device.
2. Connection: **Address** `127.0.0.1`, **Port** `47200`. The profile talks HTTP to
   SplycedBoard on the Pro Host.
3. No username or password is needed; SplycedBoard handles authentication with the processor.

### Lighting data table

**Address1 = LEAP Zone ID.** Every zone's ID is shown on the **Loads** tab. They're stable
integers assigned by the processor, not the addresses from Designer's device list.

The **⬇ Export** button on the Loads tab downloads a ready-made `lighting_export.plist` for
Blueprint's lighting table. Set **Blueprint Component Name** on the Setup tab first, so the
rows point at your component.

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

All on port 47200. The profile (v1.11 and earlier) calls these without the `/lutron` segment,
for example `/api/zone/level`. SplycedBoard answers on both paths, so existing Blueprint
configurations keep working unchanged.

| Endpoint | Purpose |
|---|---|
| `GET /api/lutron/zone/query?id=` | `{ "level": n }`, polled by QueryDimmerLevel every 5 s |
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

**Processor not found by the scan.** mDNS is often blocked by VLANs, managed switches or
firewalls. Use **Manual Entry**, and check the processor answers `ping`.

**Pairing times out or fails with "Connection error".**
- LEAP must be enabled (and on some QSX firmware, licensed) in HomeWorks Designer.
- Pairing mode must be active **before** you click Pair Now; the window is about 30 s.
- Port 8083 must be reachable: `nc -zv <processor-ip> 8083`.

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

**Certificates missing.** The pairing record exists but its certificate files don't (for
example, the `data/` folder was partly copied). Pair again from the Setup tab.
