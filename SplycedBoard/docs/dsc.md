# DSC PowerSeries Pro (ITv2) — proof of concept

SplycedBoard talks to a DSC PowerSeries Pro (HS3032 / HS3128 / HS3248) or PowerSeries Neo
panel over **ITv2**, DSC's third-party integration protocol, through the panel's IP
communicator. For now it's dashboard only: arm away / stay / night, disarm, and zone status.
There's no Savant profile yet. If the dashboard can talk to the panel, Savant can talk to
SplycedBoard.

It's a **beta** feature: it only shows up (in the menu, on the Overview, in the installer)
with **Settings → Beta features** switched on. Switched off, it's hidden and stopped.

The test it exists for: Alarm.com on one of the panel's communication paths and the ITv2
integration session on the other, at the same time. (Savant's own DSC Neo profiles say their
ITv2 link can't run alongside an Alarm.com CD8080, because both use the same integration
port.)

## How it works

- **The ITv2 session.** The panel's communicator dials SplycedBoard (it's programmed with the
  Savant host's IP as its integration server) and the two open a session, encrypted with
  AES-128 using keys from the integration ID and access code. The panel picks the encryption
  type: type 1 (an 8-digit access code) or type 2 (32 hex digits). Savant's own DSC Neo
  profiles speak the same protocol through a plugin built into SavantOS
  (`ITv2Protocol.avccoproc`); SplycedBoard does that job itself. The protocol details come
  from the open-source ITv2 servers (NeoHub, LawPaul's dsc-itv2) and real packet captures;
  DSC only gives its specification out under NDA.
- **The dashboard** (DSC PowerSeries Pro in the nav) has three tabs:
  - **Panel**: partitions, with arm and disarm (a user code each time; it isn't stored), and
    zones with their status and labels.
  - **Connection**: the settings (the port SplycedBoard listens on, the integration ID and
    access code) and the session's state.
  - **Messages**: every ITv2 message both ways, decrypted and decoded, with user codes
    masked. Copy it out when something doesn't work.

## Setting it up

1. **In SplycedBoard**: Settings → **Beta features** on, then switch **DSC PowerSeries Pro**
   on (Overview). Its **Connection** tab takes the integration ID and access code below.
2. **Program the communicator** (installer programming: `[*][8][installer code][851][section]`).
   Use an integration session nothing else uses: Alarm.com, PowerManage or DLS may already
   have one. Session 1 is below; sessions 2–4 repeat the same sections further on (Neo:
   from `[450]`, `[477]` and `[504]`).

   | Section | PowerSeries Pro | PowerSeries Neo (communicator firmware 5.x) |
   |---|---|---|
   | `[422]` integration ID | read it (12 characters) into SplycedBoard | the same |
   | access code | `[423]`: 32 hex digits (type 2) | type 1: `[423]`, 8 hex digits; type 2: `[700]`, 32 hex |
   | `[425]` options | 3, 4, 5 (Ethernet, type 2, ITv2) | 3 and 5 (type 1), or 3, 4, 5 (type 2) |
   | `[426]` options | 3 and 4 (real-time notification) | 3 only |
   | `[428]` server IP | the Savant host's IP, 3 digits an octet | the same |
   | `[429]` port | `03072` (decimal on the Pro) | `0C00` (hex: 3072) |

   Then exit programming (`[851][999]` = `55` restarts the communicator).
   Optionally, `[711]` sets how long the communicator waits on a quiet session (default 300
   seconds); SplycedBoard polls every 50.
   - **PowerSeries Pro:** `[382]` option 5 makes the panel expect an external alternate
     communicator (an Alarm.com module). With it on and no such module fitted, the panel
     reports nothing, on any path.
   - **Avoid the polling modes** (`[426]` options 1 and 2): a Pro set to TCP polling sends
     HTTP, not ITv2.
   - Newer communicator firmware (5.63) first offers an undocumented "type 3" encryption;
     SplycedBoard turns it down, as Johnson Controls' own cloud does, and the panel falls back
     to type 1 or 2.
3. Watch the **Messages** tab: the panel dials in, the session opens (`Session open (AES-128-ECB,
   type 2)`), the panel reports its partitions and zones, and the Panel tab fills in. A wrong
   integration ID or access code shows there, during the handshake.

## Removing it

Everything is in one place, so taking it out is deleting files:

| What | Where |
|---|---|
| The integration | `SplycedBoard/src/integrations/dsc/` (protocol, panel model, dashboard page) |
| Its registry line | `'dsc'` in `SplycedBoard/src/integrations/index.js` |
| This page | `SplycedBoard/docs/dsc.md` |
| Tests | `test/dsc.test.js`, `test/dsc-session.test.js`, `test/support/mock-dsc.js` |
| On a host | `data/dsc/` (its settings) in SplycedBoard's data folder |
