# Adding an integration

An integration is one folder under `src/integrations/`, one line in the registry, and
(usually) one Savant profile in `profiles/`. The hub takes care of everything else: the
on/off switch, the dashboard page and nav entry, the API mount point, settings storage,
logging, and the WebSocket.

Code paths below are inside the `SplycedBoard/` folder (what ships to a Pro Host); `test/` is
at the repository root and doesn't ship.

The walkthrough below builds a made-up integration, `mydevice`. For complete real examples,
read `src/integrations/scli` (small: two TCP servers) and `src/integrations/appletv` (bigger:
several devices of one kind, PIN pairing, a persistent connection per device, and one Savant
component per device, addressed by a state variable).

## 1. The folder

```
src/integrations/mydevice/
  manifest.json      what it is (read without loading any code; the installer uses it)
  index.js           create(ctx) → the running integration
  ui/panel.html      dashboard page (optional)
  ui/panel.js        its script
  ui/panel.css       its styles (optional)
profiles/mymaker_my device.xml   the Savant component profile (named as in section 5)
```

Then add the id to `INTEGRATIONS` in `src/integrations/index.js`.

## 2. manifest.json

```json
{
  "id": "mydevice",
  "name": "My Device",
  "icon": "🔷",
  "description": "What it controls, in one sentence — shown on the Overview card and in the installer.",
  "profile": "mymaker_my device.xml",
  "defaultEnabled": false,
  "endpoints": [
    { "port": 47200, "protocol": "HTTP", "path": "/api/mydevice", "use": "Savant profile commands" }
  ]
}
```

- `id` must match the folder name. It becomes the API prefix (`/api/mydevice`), the settings
  folder (`data/mydevice/`), the log tag (`[mydevice]`) and the dashboard route (`#/mydevice`).
- `defaultEnabled` decides whether a fresh install switches it on. Integrations use `false`: a
  new install starts with every integration off, and the installer doesn't ask.
- `"category": "tool"` makes it a tool rather than an integration: the dashboard lists it under
  Tools, leaves it off the Overview, and the installer doesn't offer it. A tool has no Savant
  profile; the TV tools (`samsungtv`, `lgtv`, `sonytv`) are `core/tv/tool.js` with a driver each.
- `endpoints` is shown on the Overview card, for the installer's reference.

## 3. index.js — the contract

```js
const express = require('express');

class MyDeviceIntegration {
  constructor(ctx) {
    this.ctx = ctx;            // see "ctx" below
    this.devices = new Map();
    this.router = this._routes();   // mounted at /api/mydevice; answers 503 while switched off
  }

  // Open sockets, start discovery, connect to devices. Throw to report a failure;
  // the hub shows the message on the dashboard and keeps everything else running.
  async start() {
    const { devices = [] } = this.ctx.settings.load();
    // ...connect...
    this.ctx.log.info(`Started with ${devices.length} devices`);
  }

  // Release EVERYTHING start() opened — servers, sockets, timers. The hub calls this when
  // the integration is switched off, when start() fails, and on shutdown.
  async stop() {}

  // One line for the Overview card and the nav dot.
  // level: 'ok' (green) | 'warn' (yellow) | 'error' (red) | 'idle' (grey)
  status() {
    return { level: 'ok', text: `${this.devices.size} devices connected` };
  }

  // Optional: WebSocket messages a dashboard needs when it first connects.
  hello() {
    return [{ type: 'devices', devices: [...this.devices.values()] }];
  }

  _routes() {
    const router = express.Router();
    // Savant profiles call GET endpoints with query strings — keep them simple.
    router.get('/key', async (req, res) => {
      // /api/mydevice/key?ip=192.168.1.60&key=menu
      res.json({ ok: true });
    });
    return router;
  }
}

module.exports = { create: (ctx) => new MyDeviceIntegration(ctx) };
```

### ctx

| | |
|---|---|
| `ctx.id`, `ctx.manifest` | Who you are |
| `ctx.log` | `info / warn / error / debug(...)` and `child('sub')` → tag `mydevice:sub`. Use `debug` for per-command traffic; it's shown when Verbose logging is on. |
| `ctx.settings` | JSON store at `data/mydevice/settings.json`: `load()`, `save(obj)`, `update(fn)`, `exists()` |
| `ctx.dataDir` | `data/mydevice/`, for credentials, pairing files, etc. |
| `ctx.broadcast(type, payload)` | Sends `{ source: 'mydevice', type, ...payload }` to every open dashboard |
| `ctx.statusChanged()` | Call when `status()` would return something new; the Overview updates live |

### Rules of thumb

- `start()` must be quick. Don't wait on devices being reachable; connect in the background
  and report progress through `status()` + `ctx.statusChanged()`.
- `stop()` must leave nothing behind, because the integration can be switched on and off
  repeatedly. Use `listen()` / `close()` from `src/core/net.js` for servers: they turn
  "port in use" into a clear status message.
- Put settings and credentials in `ctx.settings` / `ctx.dataDir`, never in the code folder.
  Updates replace the code folder.
- Add a test: `test/lutron.test.js` shows the pattern (boot a hub in-process, drive it over
  HTTP/TCP against a mock device).

## 4. The dashboard panel

`ui/panel.html` is injected into the integration's page. `ui/panel.js` registers the panel:

```js
(() => {
  let ctx;
  const $ = (id) => document.getElementById(id);

  SB.registerPanel('mydevice', {
    // ctx = { root, api(method, path, body), esc, toast }
    // api() is scoped to /api/mydevice and throws with the server's error message.
    init(context) { ctx = context; },

    // Called with the integration's hub record whenever enabled/running/status changes.
    onStateChange(integration) {
      if (integration.running) ctx.api('GET', '/devices').then(render);
    },

    // ctx.broadcast() messages from the server side.
    onMessage(msg) {
      if (msg.type === 'devices') render(msg);
    },
  });

  window.MyDevice = { /* functions used by inline onclick="" handlers */ };
})();
```

- Element IDs are global to the whole dashboard, so prefix them (`mdDeviceList`, not `deviceList`).
- Shared styles are in `public/css/app.css`: `card`, `btn btn-primary|secondary|ghost`,
  `subnav` + `tab-btn` + `tab-pane` for tabs, `panel-header`, `toggle`, `alert`, `note`,
  `empty-state`, `info-chip`.
- Escape anything that came from a device with `ctx.esc()` before putting it in HTML.
- The hub shows the "switched off" banner and dims the panel for you.

## 5. The Savant profile

**Name the file after the profile's own `manufacturer` and `model`**, lowercase, joined by an
underscore: `manufacturer="MyMaker" model="My Device"` → `mymaker_my device.xml`. That's how
Savant names its own library, and how Blueprint finds a profile. Under any other name Blueprint
still lists the component, but adding it fails with "Component not found".
`test/profiles.test.js` checks every profile.

**Every change to a profile must bump its version.** Increase `rpm_xml_version` on the root
`<component>` element (1.9 → 1.10 → 1.11), change `version=` in its ReportProfileVersion
action to match, and add a line to the Change Log in its `<notes>`. `test/profiles.test.js`
fails when a profile changed since the last release tag without a higher version.

**Make it report its version.** A ReportProfileVersion action, run when Savant starts and
every minute, tells SplycedBoard which version Savant runs, so the dashboard can warn when it
isn't the one SplycedBoard ships. Put it in `<custom_component_actions>`:

```xml
<action name="ReportProfileVersion">
    <command_interface interface="ip">
        <command response_required="no">
            <command_string type="character" http_request_type="GET">api/hub/profile-report</command_string>
            <parameter_list>
                <parameter parameter_data_type="character"><![CDATA[?integration=mydevice&version=1.0]]></parameter>
            </parameter_list>
        </command>
    </command_interface>
    <execute_on_schedule period_ms="0"/>
    <execute_on_schedule period_ms="60000"/>
</action>
```

Savant can't read `rpm_xml_version` itself, so the version is written out here, and the
test checks the two match. With one component per device, append `&device=` and the device's
address, as the Apple TV profile does. That makes the dashboard report each device separately.

Point HTTP commands at `127.0.0.1:47200` with `command_string` paths under
`api/mydevice/…`, the same way the Lutron profile (`profiles/lutron_leap bridge.xml`) does.

For several devices of the same kind (like Apple TVs), use one Savant component per device
and a user-editable state variable holding that device's IP. Pass it in every command, as
`profiles/apple_apple tv (splycedboard).xml` does with `AppleTVAddress`, and add a test that
reads the profile and calls every action against the server, like `test/appletv.test.js` does.

The Overview card and Settings page offer the profile for download, and the installer can copy
it into Blueprint.

## 6. Try it

```bash
npm test                    # from the repository root
SplycedBoard/scripts/dev    # run the service in the foreground with live logs
npm run package && npm run check-package   # after committing: does the host download include it?
```
