# TV tools: Samsung TV, LG TV, Sony TV

The dashboard's **Tools** section has a page per TV brand. Each one:

- **scans the network** for that brand's TVs and shows each one's model, model year, IP and MAC
  address;
- **gets or checks the key** Savant's IP profiles need for that TV, ready to copy into Blueprint;
- **lists the TVs in the Blueprint configuration this host runs**, with the key Blueprint has for
  each, and **warns** when one is missing or doesn't work;
- works any TV in the list **like a remote**: power, volume, mute, the arrows and OK, Back, Home,
  Menu, inputs, channels, numbers and playback. The keyboard works too: arrows move, Space or
  Enter is OK, Backspace is Back, + and − change the volume, M is Menu, H is Home, Esc closes
  the remote. Handy when the TV's own remote has gone missing.

They're tools, not integrations: Savant keeps controlling the TVs through its own profiles, and
nothing here is needed at run time. They have no Savant profile and nothing to switch on.

## Samsung TV

Samsung has changed how its TVs are controlled over the years. The page works out which
generation each TV is from its model code and number, and uses what that TV has:

| Years | Models | SplycedBoard | Savant |
|---|---|---|---|
| 2020 and newer | T, A, B, C, D, F: Q60T, QN90A, S95C, The Frame LS03T… | IP Control (port 1516) | IP, with the **AccessToken** in Blueprint |
| 2016–2019 | M, N, R and some K: MU8000, NU8000, RU8000, Q7F–Q9F, Q60R–Q90R, KS7000, The Frame LS003/LS03N/LS03R… | IP Control (port 1515) on the models with IP Remote; Smart View (ports 8001/8002) otherwise | IP, with the **AccessToken** in Blueprint, on the models with IP Remote; IR or RS-232 otherwise |
| 2014–2015 | H, J | the legacy remote (port 55000) where the TV has it; J models with PIN pairing aren't supported | IR or RS-232 |
| 2010–2013 | C, D, E, F | the legacy remote (port 55000) | IR or RS-232 |

**Getting the AccessToken.** Savant's own way to get it goes through System
Monitor's UPnP Discovery, or a CreateToken service request, which often fails. Here:

1. Connect the TV by Ethernet and turn on **IP Remote**. 2020 and newer: Home → Settings → All
   Settings → Connection → Network → Expert Settings → IP Remote → Enable. 2016–2019: Home →
   Settings → General → Network → Expert Settings → IP Remote → Enable. Then pick **Check** on
   the TV's card.
2. Turn the TV on, pick **Request token** on the TV's card, and pick **Allow** on the TV within
   30 seconds.
3. Copy the token. In Blueprint, inspect the TV, choose State Variables in the Show menu, and
   paste it as `AccessToken`. Upload the configuration.

IP Control is the same on both ports: the same token, the same commands. Only the port and the
menu that turns it on changed in 2020.

When a TV has no IP Control to reach (IP Remote off, or a model without it), the button says
**Pair remote**. It pairs SplycedBoard's own remote over Smart View (Allow on the TV once); that
token is shown for reference, but Savant doesn't use it. A 2020-or-newer TV, or one whose
Blueprint profile expects an AccessToken, gets a warning to turn IP Remote on.

Switching on is **Wake-on-LAN**, which needs the MAC address. A scan fills it in; it's also
what Blueprint wants under the TV's IP address for Savant's own power-on.

## LG TV

LG TVs don't hand a key over the network: you turn on **Network IP Control** in a hidden menu,
and the TV shows a **keycode**. Blueprint's LG profiles call it the AccessToken. The page has
the steps for each generation (from Savant's LG profiles):

- **2021 and newer**: Settings (cog) → All Settings → General → hover over Network (don't open
  it) → press **7 3 7 7 7** → Network IP Control On → **Generate Keycode** → back, and turn on
  Wake On LAN.
- **2018–2020**: hold Settings for 5 seconds → hover over the network item → press
  **7 3 7 7 7** (or 8 2 8 8 8) → Network IP Control On → **Generate Keycode**.
- **2016–2017**: on Live TV hold Settings for 5 seconds → enter **8 2 8** (or 8 2 8 8 8) → Network
  IP Control On → reboot. These take no keycode.

Type the keycode into the TV's card and pick **Save & test**: SplycedBoard asks the TV for its
MAC address with it, which only works with the right keycode (it's case sensitive). Then set
`AccessToken` to it in Blueprint. The connection is TCP 9761, encrypted with the keycode the
way Savant's LG profiles do it; switching on is Wake-on-LAN.

## Sony TV

The key is a **Pre-Shared Key** set on the TV, and Savant's Sony profiles have **1234** written
into them, so that's what every TV needs:

1. Network → **Remote Start** → On (for switching on over the network).
2. Home network setup → IP Control → **Authentication** → Normal and Pre-Shared Key.
3. Home network setup → IP Control → **Pre-Shared Key** → 1234.
4. Remote device settings → **Control Remotely** → On.

New TVs start with 1234 in the page, and it checks the key straight away. If a TV worked and
stopped after a firmware update (HTTP 403), clear its Pre-Shared Key field completely, including
a hidden space before 1234, and type it again. A profile with a different key written in is
read from Blueprint's configuration, and the page warns when the TV's key doesn't match it.

## The TVs in Blueprint's configuration

The pages read the configuration Savant runs on this host (the one uploaded from Blueprint),
not a Blueprint document on another Mac:

- which components are TVs of that brand (`serviceImplementation.sqlite`: name, room, make and
  model; Blueprint's `HD_monitor` components, not Blu-ray players, soundbars or projectors);
- each TV's IP and MAC address (its network connection in `componentConnections.plist`);
- the key: the `AccessToken` state variable (`componentStateVariables.plist`) for Samsung and LG,
  or the Pre-Shared Key written into the TV's profile for Sony (the profiles Savant keeps in
  `componentProfiles/`).

TVs with an IP address are added to the list and marked with their component and room. They
stay while they're in the configuration. A TV whose profile keeps its key in a state variable
gets a warning when Blueprint has none, or has a different one than the TV takes. TVs with no
IP address are named at the top of the page: Savant controls those by IR or RS-232. After a new
upload, the page picks up the changes within 30 seconds, or at once with **Check all**.

## Scanning

A scan lists the addresses in use on the host's networks (from the ARP table, after nudging each
address), asks those on the brand's ports (Samsung 8001, 1516, 1515, 55000; LG 9761; Sony 80), and
asks the network with SSDP. Each device that answers is asked who it is. It takes a few
seconds. A TV on another VLAN can be added by its IP instead.

On macOS 15 and later, scanning needs the **Local Network** permission for bun (System
Settings → Privacy & Security → Local Network), like the other integrations' scans.

## Ports

All outgoing, from the Pro Host to the TVs:

| Brand | Ports |
|---|---|
| Samsung | 1516 and 1515 (IP Control, HTTPS), 8001/8002 (Smart View), 55000 (legacy), SSDP 1900/UDP |
| LG | 9761 (IP control), SSDP 1900/UDP |
| Sony | 80 (REST and IRCC), SSDP 1900/UDP |
| All | Wake-on-LAN, UDP 9 and 7 (broadcast) |

## Where things live

Each tool's list, keys and tokens are in `…/SplycedBoard/data/<samsungtv|lgtv|sonytv>/settings.json`.
