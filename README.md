# Savant · Lutron LEAP Bridge

A custom integration bridge that connects Savant Pro to Lutron HomeWorks QSX and RadioRA 3 systems using the LEAP protocol. Replaces the official Savant LEAP bridge (LCB-LEINT-00) with a fully open, installer-controlled solution.

---

## How It Works

Savant's profile engine speaks plain TCP (telnet-style). Lutron LEAP runs over SSL/TLS. This bridge sits in between:

```
Savant Pro Host
      │
      │  Plain TCP · port 8023 · localhost
      ▼
 savant-leap-bridge   (runs on the same Mac Mini as Savant)
      │
      │  LEAP JSON over SSL/TLS · port 8081
      ▼
 Lutron QSX or RA3 Processor
```

The bridge presents the same command protocol as a HomeworksQS to Savant, so Savant's lighting table works natively — no special drivers, no cloud dependency.

A built-in web UI (port 47200) handles processor discovery, certificate pairing, and real-time load testing.

---

## Requirements

| Requirement | Notes |
|---|---|
| Savant Pro Host | Mac Mini running Savant Pro Host software |
| Bun | Install from [bun.sh](https://bun.sh) — see command below |
| Lutron QSX or RA3 | LEAP must be enabled in HomeWorks Designer |
| Network | Bridge Mac and Lutron processor on same LAN |

Install Bun on the Pro Host:

```bash
curl -fsSL https://bun.sh/install | bash
```

---

## Installation

### 1. Copy files to the Pro Host

Transfer the `savant-leap` folder (inside this repo) to the Pro Host Mac Mini. Options:
- AirDrop
- Shared folder / USB drive
- `scp -r savant-leap/ user@prohost-ip:~/savant-leap`

### 2. Run the installer

Open Terminal on the Pro Host and run:

```bash
bash ~/savant-leap/scripts/install.sh
```

This will:
- Copy files to `~/savant-leap`
- Run `bun install` (downloads dependencies)
- Install and start the launchd service (auto-starts on login/reboot)

### 3. Verify it's running

```bash
bash ~/savant-leap/scripts/logs.sh
```

You should see:

```
[web]    UI available at http://localhost:47200
[bridge] Savant TCP bridge listening on port 8023
[app]    No paired processor. Open http://localhost:47200 to set up.
```

---

## Pairing with the Lutron Processor

Pairing generates SSL certificates that authenticate the bridge to the Lutron processor. This only needs to be done once.

### Before you start

In **HomeWorks Designer** (QSX) or **RA3 Setup** software:
- Ensure **LEAP integration** is enabled on the processor
- For QSX: create a "Pairing" button on any keypad, or use the pairing feature in HomeWorks Designer under the processor settings
- For RA3: locate the physical pairing button on the processor

### Steps

1. Open the web UI from any browser on the same network:
   ```
   http://{pro-host-ip}:47200
   ```
   If you're working directly on the Pro Host, use `http://localhost:47200`

2. Go to the **Setup** tab

3. Click **Scan Network** — the bridge will scan for Lutron processors via mDNS for 8 seconds. If found, they appear as clickable items.

4. If your processor doesn't appear (mDNS can be blocked on some networks), use **Manual Entry** and type the processor's IP address directly.

5. Select the processor or enter the IP, then click **Pair Now**

6. **Within 30 seconds**, press the pairing button on the Lutron keypad (or enable pairing mode in HomeWorks Designer). The bridge connects on port 8083, exchanges certificates, and stores them in `~/savant-leap/config/certs/`.

7. On success, the bridge automatically connects and loads the inventory. The status indicator in the top-right corner turns green.

> **Certificates are stored locally** in `~/savant-leap/config/certs/`. Back these up if you plan to reinstall macOS or migrate to a new machine.

---

## Blueprint Setup

### Install the profile

Copy `profile/lutron_leap_bridge.xml` to the Blueprint component profiles folder on your **development machine** (not the Pro Host):

```
~/Library/Application Support/RacePointMedia/systemConfig.rpmConfig/componentProfiles/
```

Restart Blueprint if it was open.

### Add the device

1. In Blueprint, place a new **Lutron LEAP Bridge** device
2. Set the connection:
   - **Host / Address**: `127.0.0.1`
   - **Port**: `8023`
3. No username or password required — the bridge handles authentication internally

### Build the lighting data table

Use the **Lighting Data Table** exactly as you would for a HomeworksQS device.

**Address1 = LEAP Zone ID**

Find the Zone ID for each load in the bridge web UI under the **Loads** tab — every zone shows its ID, name, and parent area. Zone IDs are stable integers assigned by the Lutron processor.

| Data Table Column | Value |
|---|---|
| Address1 | LEAP Zone ID (from Loads tab) |
| Entity | `Dimmer` or `Switch` |
| Address2+ | Not used |

For **keypads**:

| Data Table Column | Value |
|---|---|
| Address1 | LEAP Device ID (from Keypads tab) |
| Address2 | Button Number |
| Address3 | LED ID (same as Button Number in most cases) |
| Entity | `Keypad Button` |

For **scenes**:

| Data Table Column | Value |
|---|---|
| Address1 | LEAP Virtual Button ID (from Scenes tab) |
| Entity | `Button Press And Release` |

### Build the shade data table

Shades are added through the **Shade Data Table**, separate from the lighting table.

| Data Table Column | Value |
|---|---|
| Address1 | LEAP Zone ID (from Loads tab) |
| Entity | `Variable Shade` or `Shade` |
| Address2+ | Not used |

> The bridge automatically sends `~SHADEGRP` feedback for shade-type zones and `~OUTPUT` feedback for dimmer/switch zones. The zone type is read from the Lutron processor's `ControlType` field — `Shade` and `ShadeWithTilt` zones use the shade protocol automatically.

### State variables

These can be adjusted in Blueprint under the device's **State Variables**:

| Variable | Default | Description |
|---|---|---|
| `SystemType` | `QSX` | Informational. Set to `QSX` or `RA3`. |
| `FadeTime` | `1` | Default fade time in seconds for switch on/off actions |

---

## Web UI Reference

Open `http://{pro-host-ip}:47200` from any browser on the network.

### Setup tab

- **Scan Network** — mDNS discovery of Lutron processors (8 second scan)
- **Manual Entry** — enter processor IP directly if mDNS discovery fails
- **Pair Now** — initiates certificate exchange with the selected processor
- **Reconnect** — manually reconnect if the LEAP connection dropped

### Loads tab

Shows all zones grouped by area with real-time status and direct control:

- **Dimmers** — slider (0–100%) + raise/lower buttons
- **Shades** — slider + open/stop/close buttons
- **Switches** — on/off toggle
- **Fans** — Off / Low / Med / High speed buttons

All controls are live — changes are sent to the processor immediately and reflected in Savant.

Use the **search bar** to filter by zone name or area name.

### Keypads tab

Shows all keypads and their buttons. Press and hold to simulate a physical button press. LED indicators reflect the current state from the processor.

### Scenes tab

Lists all programmed virtual buttons (scenes). Click any scene to recall it.

---

## Running Without Installing (Test Mode)

To run the bridge in a terminal window for testing without installing it as a background service:

```bash
bash scripts/test-run.sh
```

This runs the bridge in the foreground with color-coded console output. Press **Ctrl-C** to stop.

### Console output legend

| Color | Prefix | Meaning |
|---|---|---|
| Cyan | `[savant →]` | Command received from Savant |
| Yellow | `[leap →]` | Command sent to Lutron processor |
| Green | `[leap ←]` | Zone level update received from Lutron |
| Magenta | `[→ savant]` | Feedback sent back to Savant |

Example session:
```
14:23:01  [leap] Connected to 192.168.1.50
14:23:02  [controller] Loaded 42 zones, 18 devices, 12 button groups
14:23:03  [bridge] Savant connected from 127.0.0.1:51234
14:23:10  [savant →]  #OUTPUT,5,1,100,1,0
14:23:10  [leap →]    setLevel zone 5 (Kitchen Pendants) → 100% fade=1
14:23:10  [leap ←]    zone 5 (Kitchen Pendants) 0 → 100%
14:23:10  [→ savant]  ~OUTPUT,5,1,100.
14:23:15  [savant →]  #SHADEGRP,12,1,75,2
14:23:15  [leap →]    setLevel zone 12 (Living Room Shades) → 75% fade=2
14:23:15  [leap ←]    zone 12 (Living Room Shades) 0 → 75%
14:23:15  [→ savant]  ~SHADEGRP,12,1,75.
```

---

## Service Management

The bridge runs as a launchd agent on the Pro Host — it starts automatically when the user logs in and restarts itself if it crashes.

### Common commands

```bash
# View live logs
bash ~/savant-leap/scripts/logs.sh

# View error logs
bash ~/savant-leap/scripts/logs.sh error

# Stop the service
launchctl unload ~/Library/LaunchAgents/com.savant.lutron-bridge.plist

# Start the service
launchctl load ~/Library/LaunchAgents/com.savant.lutron-bridge.plist

# Check if running
launchctl list com.savant.lutron-bridge

# Update to a new version (preserves config/certs)
bash ~/savant-leap/scripts/update.sh

# Uninstall
bash ~/savant-leap/scripts/uninstall.sh
```

Log files are at:
```
~/savant-leap/logs/bridge.log
~/savant-leap/logs/bridge-error.log
```

---

## Troubleshooting

### Bridge won't start

```bash
bash ~/savant-leap/scripts/logs.sh error
```

Common causes:
- **Port 8023 in use** — check if another process is using it: `lsof -i :8023`
- **Port 47200 in use** — check: `lsof -i :47200`
- **Bun not found** — verify: `bun --version`. Install from https://bun.sh

### Processor not found by mDNS scan

mDNS can be blocked by VLANs, managed switches, or firewall rules. Use **Manual Entry** on the Setup tab instead.

Verify the processor is reachable:
```bash
ping {processor-ip}
```

### Pairing fails — "Connection error" or timeout

- Ensure LEAP is enabled on the processor in HomeWorks Designer
- Ensure the processor is in pairing mode (button pressed or enabled in software) **before** clicking Pair Now — there is a ~30 second window
- Check that port 8083 is reachable: `nc -zv {processor-ip} 8083`
- Some QSX firmware versions require LEAP to be explicitly licensed — check processor licenses in HomeWorks Designer

### Pairing fails — "Pairing rejected by processor"

The processor returned an error. This usually means:
- Pairing mode was not active when the request was sent
- Too many clients are already paired (processor limit)
- LEAP integration is disabled or not licensed

### Connected but no zones load

The bridge connected to the processor but got no zone data. Check:
- LEAP integration is fully configured (zones assigned in HomeWorks Designer)
- The paired certificate has sufficient access rights
- Check the logs for specific LEAP error responses

### Savant shows no feedback / loads not responding

1. Verify the bridge is running: `launchctl list com.savant.lutron-bridge`
2. Confirm Blueprint has the correct host (`127.0.0.1`) and port (`8023`)
3. Run in test mode (`bash scripts/test-run.sh`) and trigger a command from Savant — you should see `[savant →]` lines appear
4. Check that Address1 in the data table matches the Zone ID shown in the Loads tab

### Zone IDs don't match what I expect

LEAP Zone IDs are assigned by the Lutron processor and are shown in the **Loads** tab of the web UI. These are the IDs to use in the Savant data table — not the addresses from HomeWorks Designer's device list or from the old HomeworksQS integration.

### Lights respond but no feedback to Savant

The `~OUTPUT` feedback line requires the bridge to receive zone status updates from the processor via LEAP subscription. If feedback is missing:
- Check `[leap ←]` lines are appearing in test mode when lights change
- The LEAP subscription may have failed — check logs for subscription errors
- Try reconnecting via the Setup tab

---

## File Layout

### Repo / distribution

```
savant-lutron/                 ← this repo
├── savant-leap/               ← copy this folder to the Pro Host
│   ├── src/
│   │   ├── index.js               ← entry point
│   │   ├── config.js              ← config + cert storage
│   │   ├── discovery.js           ← mDNS processor discovery
│   │   ├── pairing.js             ← LEAP certificate pairing
│   │   ├── leap/
│   │   │   ├── client.js          ← raw TLS LEAP client
│   │   │   └── controller.js      ← zones, scenes, keypads, events
│   │   ├── bridge/
│   │   │   └── tcp-server.js      ← Savant TCP bridge (port 8023)
│   │   └── web/
│   │       └── server.js          ← web UI server (port 47200)
│   ├── public/
│   │   └── index.html             ← web UI (single file)
│   ├── scripts/
│   │   ├── install.sh             ← install + start launchd service
│   │   ├── update.sh              ← update files + restart service
│   │   ├── uninstall.sh           ← remove service + files
│   │   ├── test-run.sh            ← run in terminal (no launchd)
│   │   └── logs.sh                ← tail live logs
│   └── package.json
├── profile/
│   └── lutron_leap_bridge.xml ← Blueprint component profile (dev machine only)
└── README.md
```

### Installed on Pro Host

```
~/savant-leap/                 ← installed by install.sh
├── src/
├── public/
├── scripts/
├── package.json
├── config/                    ← created at runtime
│   ├── settings.json          ← paired processor info
│   └── certs/                 ← SSL certificates (back these up)
└── logs/                      ← created at runtime
    ├── bridge.log
    └── bridge-error.log
```

---

## Protocol Reference

The bridge speaks the same telnet protocol as a HomeworksQS processor. These are the raw commands Savant sends and the feedback it receives:

### Commands (Savant → Bridge)

| Command | Description |
|---|---|
| `#OUTPUT,{id},1,{level},{fade},{delay}` | Set dimmer/switch zone level (0–100) |
| `#OUTPUT,{id},2` | Start raising |
| `#OUTPUT,{id},3` | Start lowering |
| `#OUTPUT,{id},4` | Stop raising/lowering |
| `#SHADEGRP,{id},1,{level},{delay}` | Set shade zone level (0–100) |
| `#SHADEGRP,{id},2` | Open shade (raise) |
| `#SHADEGRP,{id},3` | Close shade (lower) |
| `#SHADEGRP,{id},4` | Stop shade |
| `#AREA,{id},1,{level},{fade},{delay}` | Set area level |
| `#DEVICE,{deviceId},{buttonNum},3` | Button press |
| `#DEVICE,{deviceId},{buttonNum},4` | Button release |
| `#VIRTUALBUTTON,{id},3` | Recall scene |
| `?OUTPUT,{id},1` | Query dimmer/switch zone level |
| `?SHADEGRP,{id},1` | Query shade zone level |

### Feedback (Bridge → Savant)

| Message | Description |
|---|---|
| `~OUTPUT,{id},1,{level}.` | Dimmer/switch zone level changed |
| `~SHADEGRP,{id},1,{level}.` | Shade zone level changed |
| `~AREA,{id},1,{level}.` | Area level changed |
| `~DEVICE,{deviceId},{buttonNum},09,{00\|01}` | LED state changed |

---

## Supported Hardware

| Device | Support |
|---|---|
| HomeWorks QSX | Full — dimmers, switches, shades, keypads, scenes |
| RadioRA 3 | Full — same LEAP protocol |
| Caséta (Smart Bridge Pro 2) | Partial — LEAP pairing may differ; mDNS discovery works |
| RadioRA 2 | Not supported — uses different telnet protocol (use existing HomeworksQS profile directly) |
