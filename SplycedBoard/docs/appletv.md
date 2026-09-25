# Apple TV

IP control of any number of Apple TVs, over **Apple's Companion protocol**. It's the protocol the
iPhone's Remote uses, paired with a 4-digit PIN shown on the TV. It needs **no HomeKit, no IR,
and no Savant coprocessor**.

Each Apple TV is its own Savant component, addressed by its IP address. A house with 2, 4 or
10 Apple TVs just has 2, 4 or 10 components.

```
Savant component "Family Room ATV"   ─┐   HTTP 127.0.0.1:47200/api/appletv/…?ip=192.168.1.50
Savant component "Primary ATV"        ├──►  SplycedBoard ──► Companion (encrypted) ──► each Apple TV
Savant component "Gym ATV"           ─┘   (one persistent connection per Apple TV)
```

## Requirements

- Apple TV HD or Apple TV 4K; a current tvOS is recommended.
- A **fixed IP address** for every Apple TV (a DHCP reservation). Savant finds each Apple TV by
  its IP.
- The Pro Host must reach each Apple TV on TCP **49153** (the Companion port) and UDP **5353**.
  Discovery is easiest on the same network, but pairing and control work across VLANs if you
  type the IP.

## 1 · Pair each Apple TV (once)

1. Switch on **Apple TV** on the SplycedBoard dashboard (Overview), then open the **Apple TV**
   page.
2. Click **Add Apple TV**. Apple TVs on the network are listed; if yours isn't, type its IP.
3. Click **Pair**. A 4-digit code appears on the TV. Type it in and click **Pair**.
4. The Apple TV's card turns green. It shows the value to use for **AppleTVAddress** in
   Blueprint.

On the Apple TV, SplycedBoard now appears under **Settings → Remotes and Devices**. Removing it
there unpairs it; the dashboard then says so, and you pair it again.

The pairing is stored in `~/Desktop/SplycedBoard/data/appletv/settings.json`. It survives
updates and restarts; back that folder up.

## 2 · Blueprint

1. Download the profile from the dashboard (or take `profiles/apple_apple tv (splycedboard).xml`)
   on the Mac that runs Blueprint. Add it to your profile library in Blueprint's Preferences. On
   older Blueprint, copy it into
   `~/Library/Application Support/RacePointMedia/systemConfig.rpmConfig/componentProfiles/` and
   restart Blueprint. Keep the file name: Blueprint finds a profile by its
   `<manufacturer>_<model>` file name, so a renamed copy gives "Component not found".
2. For **each** Apple TV, add an **Apple TV (SplycedBoard)** component. Connect its HDMI output
   as you normally would.
3. Set each component's **IP address to `127.0.0.1`** (port 47200). Every Apple TV component
   points at SplycedBoard on the Pro Host, which does the Apple encryption.
4. **Inspect the component → Show → State Variables** and set **`AppleTVAddress`** to that Apple
   TV's IP, exactly as shown on its card in the dashboard. This is what tells the components
   apart.
5. Upload the configuration.

The Savant app shows its standard Apple TV remote for these components, the same one as for an
IR-controlled Apple TV.

From version 1.2, each component reports its profile version to SplycedBoard. The dashboard's
Overview warns when one runs a different version than SplycedBoard ships. Components still on
1.1 show as a profile that "doesn't report its version". Add the new profile to Blueprint's
library, update the components to it, and upload the configuration.

### Actions

The remote's own actions: Savant sends these from its Apple TV remote screen.

| Savant action | Does |
|---|---|
| `OSDCursorUp` / `Down` / `Left` / `Right`, `Select` | Navigate |
| `Menu` | Back |
| `Home` | Home |
| `CommandPlay`, `CommandPause` | Play / pause (discrete) |
| `PowerOn` / `PowerOff` | Wake / sleep. Always sent, so a TV its sleep timer turned off still wakes |
| `LaunchApp` (AppID) | Open an app by bundle id, e.g. `com.netflix.Netflix` (the dashboard remote lists each Apple TV's apps) |
| `PairStart`, `PairSubmitPin` (PIN) | Pair from Savant instead of the dashboard |
| `RepeatStop` | Sent by Savant when a held button is released; nothing to do |

Custom actions, for Blueprint buttons and workflows:

| Savant action | Does |
|---|---|
| `PlayPause`, `CommandStop` | Play/pause toggle; stop (= pause) |
| `CommandSkipUp` / `CommandSkipDown` | Next / previous, where the app supports it |
| `CommandScanUp` / `CommandScanDown` | Jump ±10 seconds |
| `AppSwitcher`, `ControlCenter` | Home button double-press / hold |
| `VolumeUp` / `VolumeDown` | Volume via the Apple TV (HDMI-CEC or IR to the TV/receiver). Room volume normally stays with the receiver's own profile |
| `Screensaver`, `ChannelUp`, `ChannelDown`, `Guide` | As on the Siri Remote |

### Feedback

`QueryStatus` runs at startup and every 5 seconds. SplycedBoard answers instantly from the
state it already holds. Power and playback changes are pushed to it by the Apple TV.

| State variable | Value |
|---|---|
| `AppleTVPower` | `ON`, `OFF`, or `UNKNOWN` (newer tvOS only reports power when it changes) |
| `AppleTVPlaying` | `true` while something is playing |
| `AppleTVConnected` | `true` while SplycedBoard is connected to it |

## HTTP API

On port 47200. Everything Savant uses takes `ip=` (the AppleTVAddress).

| Endpoint | |
|---|---|
| `GET /api/appletv/cmd?ip=&cmd=` | `up down left right select menu home playpause play pause stop next previous skipforward skipbackward volumeup volumedown poweron poweroff powertoggle siri screensaver channelup channeldown guide pageup pagedown` · optional `action=press\|hold\|double`, `seconds=` for skips. Savant action names (`OSDCursorUp`, `CommandPlay`…) work too. |
| `GET /api/appletv/status?ip=` | `{ "power": "ON", "playing": "false", "connected": "true", "name": "…", "state": "awake" }` |
| `GET /api/appletv/apps?ip=` | `[{ "bundleId": "com.netflix.Netflix", "name": "Netflix" }, …]` |
| `GET /api/appletv/app?ip=&id=` | Launch an app (bundle id or URL) |
| `GET /api/appletv/pair/start?ip=` · `pair/finish?ip=&pin=` | Pair without the dashboard |
| `GET /api/hub/profile-report?integration=appletv&version=&device=` | ReportProfileVersion (from 1.2): the profile version this component runs, at startup and every minute |

For example, from Terminal on the Pro Host:

```bash
curl 'http://127.0.0.1:47200/api/appletv/cmd?ip=192.168.1.50&cmd=home'
```

## Not supported yet

- **Now-playing details** (title, artwork, progress). They need Apple's MRP protocol over AirPlay,
  which is a separate piece of work. Power and play/pause state are supported.
- **Hold-to-scrub.** Each press is a complete press. `action=hold` holds for one second.
- **Keyboard/text entry** into search fields.

## Troubleshooting

**Not listed when adding.** The scan uses multicast (Bonjour), which VLANs and managed switches
often block. Type the IP instead; SplycedBoard asks that address directly.

**"Couldn't reach an Apple TV at …".** Check the IP. From the Pro Host, `nc -zv <ip> 49153`
should connect. Make sure the Apple TV is on (not unplugged) and on the network.

**"Wrong PIN".** Each attempt shows a new code on the TV. Start again and use the newest one.

**"The Apple TV no longer accepts this pairing".** SplycedBoard was removed under Settings →
Remotes and Devices on the TV, or the TV was reset. Pair it again; its card, name and
AppleTVAddress stay the same.

**Commands work but the TV/receiver volume doesn't change.** Volume goes through the Apple TV.
Set up **Settings → Remotes and Devices → Volume Control** on the Apple TV, or control volume
from the receiver's own Savant profile.

**A card says "Connecting…" or shows an error.** SplycedBoard retries by itself, backing off to
once a minute. Any command also triggers an immediate retry. If the Apple TV's Companion port
changed, SplycedBoard finds the new one by asking the Apple TV. The **Logs** page, filtered to
Apple TV, shows the details.
