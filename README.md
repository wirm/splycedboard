# SplycedBoard — development repository

**[`SplycedBoard/`](SplycedBoard/) is the product.** Copy that folder to a Savant Pro Host and run
`./install` inside it; its [README](SplycedBoard/README.md) covers installing, updating and running
it. Everything else in this repository is for developing it and never goes on a host.

| Path | What | On a host? |
|---|---|---|
| [`SplycedBoard/`](SplycedBoard/) | Installer, service, dashboard, Savant profiles, setup guides | **Yes — this whole folder** |
| [`test/`](test/) | Automated tests and mock Lutron / Apple TV devices | No |
| [`docs/ADDING-AN-INTEGRATION.md`](docs/ADDING-AN-INTEGRATION.md) | How to add an integration | No |
| [`extras/savant-modes/`](extras/savant-modes/) | Standalone mode save/restore scripts — not part of SplycedBoard | Separately, if used |
| `package.json` | Development workspace: installs SplycedBoard's dependencies plus test tools | No |

## Deploy to a Pro Host

Copy the `SplycedBoard` folder over (AirDrop, USB, or `scp -r SplycedBoard user@pro-host:~/`), then on
the host:

```bash
cd ~/SplycedBoard && ./install
```

The folder holds no dependencies or build output; the installer fetches dependencies on the host.

## Develop

```bash
npm install          # SplycedBoard's dependencies + test tools (an npm workspace, so they
                     # land in ./node_modules and SplycedBoard/ stays clean)
npm test             # end-to-end tests against mock Lutron and Apple TV devices
```

To try changes on a real Pro Host, copy the folder over and re-run `./install` (it updates in
place), or run `scripts/dev` inside the copied folder to watch it live in the terminal.

## Code layout

```
SplycedBoard/
  install                      the installer (bash + AppleScript dialogs)
  scripts/                     service scripts; lib.sh is shared with install
  profiles/                    Savant component profiles
  docs/                        setup guides for each integration
  public/                      dashboard shell (index.html, css/app.css, js/app.js)
  src/
    index.js                   entry point
    cli.js                     helper commands used by install (no dependencies)
    core/                      hub (integration lifecycle), logger, settings store, plist writer
    web/server.js              dashboard, hub API, integration API mounting, WebSocket
    integrations/
      index.js                 the registry — add new integrations here
      lutron/                  LEAP client/controller, pairing, telnet bridge, routes, Blueprint export, ui/
      appletv/                 device manager, discovery, routes, ui/
        companion/             Companion protocol: OPACK, TLV8, SRP, pairing, encrypted client
      scli/                    sclibridge server, ui/
test/                          node:test suites; support/ has the mock devices and harness
```
