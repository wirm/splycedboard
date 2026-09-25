# SplycedBoard — development repository

**[`SplycedBoard/`](SplycedBoard/) is the product.** A Savant Pro Host downloads that folder from
this repository's [releases](https://github.com/wirm/splycedboard/releases/latest) and runs
`./install` inside it; its [README](SplycedBoard/README.md) covers installing, updating and running
it. Everything else in this repository is for developing it and never goes on a host.

| Path | What | On a host? |
|---|---|---|
| [`SplycedBoard/`](SplycedBoard/) | Installer, service, dashboard, Savant profiles, setup guides | **Yes — this whole folder** |
| [`test/`](test/) | Automated tests and mock Lutron / Apple TV devices | No |
| [`tools/`](tools/) | Builds the release download and test-installs it | No |
| [`.github/workflows/release.yml`](.github/workflows/release.yml) | Publishes a release when a version tag is pushed | No |
| [`docs/ADDING-AN-INTEGRATION.md`](docs/ADDING-AN-INTEGRATION.md) | How to add an integration | No |
| [`extras/savant-modes/`](extras/savant-modes/) | Standalone mode save/restore scripts — not part of SplycedBoard | Separately, if used |
| `package.json` | Development workspace: installs SplycedBoard's dependencies plus test tools | No |

## Deploy to a Pro Host

On the host, paste this into Terminal:

```bash
cd "$(mktemp -d)" && curl -fsSLO https://github.com/wirm/splycedboard/releases/latest/download/SplycedBoard.tar.gz && tar -xzf SplycedBoard.tar.gz && ./SplycedBoard/install
```

It downloads the `SplycedBoard` folder from the latest release and opens the installer. Run the
same line again to update. Each release also carries a `SplycedBoard.zip` for browser downloads
(direct link: <https://github.com/wirm/splycedboard/releases/latest/download/SplycedBoard.zip>),
and copying the folder over by hand (AirDrop, USB, `scp -r`) still works. See
[Install](SplycedBoard/README.md#install).

The folder holds no dependencies or build output; the installer fetches dependencies on the host.

## Release

Hosts get the latest release, not whatever is on `main`. To publish one:

```bash
npm version 2.0.1 -w SplycedBoard           # sets the version in SplycedBoard/package.json
git commit -am "SplycedBoard 2.0.1"
git tag v2.0.1 && git push origin main v2.0.1
```

The tag starts the [release workflow](.github/workflows/release.yml). It runs the tests, builds
`SplycedBoard.tar.gz` and `SplycedBoard.zip` from the committed `SplycedBoard/` folder,
test-installs them on a macOS runner, and publishes the release. A tag with a hyphen, such as
`v2.1.0-beta.1`, becomes a pre-release. The `latest` links skip pre-releases, so install one from
its own release page.

To build the same files without publishing (to hand-carry to a host, say), run `npm run package`;
they land in `dist/`. `npm run check-package` then test-installs them the way a host would, in a
throwaway folder.

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
tools/                         package.sh builds the release download; check-package.js test-installs it
.github/workflows/release.yml  publishes a release for each version tag
```
