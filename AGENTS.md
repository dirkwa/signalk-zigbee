# Agent guidance

This file is read by AI coding agents working in this repo. `CLAUDE.md`
imports it.

## Project at a glance

`signalk-zigbee` is a Signal K server plugin that brings Zigbee devices into
Signal K through Zigbee2MQTT. Through
[signalk-container](https://github.com/dirkwa/signalk-container) it runs one
Mosquitto broker and one Zigbee2MQTT container per coordinator, subscribes to
the broker, and maps every device to Signal K paths with SI units, metadata
and PUT for writable values.

A coordinator is either a USB stick on the Signal K host or an espOS gateway
on the network (`zboss` over `tcp://<ip>:6638`, found through mDNS). Each
coordinator is its own Zigbee network; networks are never merged.

## Layout

- `src/index.ts`: plugin object, config schema hooks, HTTP API under
  `/plugins/signalk-zigbee/api` (status, permit-join, rename, frontend tokens).
- `src/config.ts`: schema, defaults (`applyDefaults`) and validation.
- `src/runner.ts`: start/stop, container lifecycle, espOS reconciliation.
- `src/stack.ts`: container definitions and files on disk (`mosquitto.conf`,
  seeded `configuration.yaml`, frontend tokens), USB checks.
- `src/bridge.ts`: MQTT client: devices, deltas, PUT, rename, bridge requests.
- `src/exposes.ts`: Zigbee2MQTT exposes to Signal K paths, units and metadata.
- `src/discovery.ts`: mDNS discovery of espOS coordinators.
- `public/`: the web app (`index.html`, plain JS), icon and screenshot.
- `test/*.test.ts`: vitest unit tests; `test/integration.ts`: the check the
  Signal K plugin CI runs against a real server.

## Commands

- `npm run build`: `tsc` to `dist/`
- `npm test`: type-check the tests, then vitest
- `npm run ci-lint`: eslint and prettier check, as CI runs them
- `npm run format`: prettier and `eslint --fix`

## Runtime invariants

- **Never open port 6638 on an espOS coordinator**, not even to probe it.
  The gateway accepts exactly one TCP connection, and that one belongs to
  Zigbee2MQTT.
- Settings the plugin owns reach Zigbee2MQTT as `ZIGBEE2MQTT_CONFIG_*`
  environment overrides. `configuration.yaml` is seeded once and then belongs
  to Zigbee2MQTT and its web interface. Object-valued overrides replace the
  whole object, so `device_options.retain` and `advanced.last_seen` are set
  through `bridge/request/options` instead.
- Mosquitto runs as the image's uid 1883 with the data directory bound over
  the image's `VOLUME` paths. signalk-container counts anonymous volumes as
  drift and would recreate the broker on every start; running as root would
  let the entrypoint `chown -R` the data directory, network keys included.
- Host networking puts each Zigbee2MQTT web interface on the LAN, so every
  network gets a generated frontend token, kept next to its data.
- A USB coordinator need not be visible inside the Signal K container: when
  the host probe finds it, signalk-container (1.37+) passes it from the host.
  Only when the probe cannot run is a stick Signal K cannot see refused.
- Start-up is asynchronous and a restart can overlap the previous run: after
  every `await` in the start-up path, check the run's abort signal before
  touching shared state.
- Signal K calls `start()` with `{}` until the configuration is first saved;
  `applyDefaults` fills it in.
- The App Store installs with `--ignore-scripts`; dependencies must not need
  install scripts.
- Signal K resolves `signalk.appIcon` and `signalk.screenshots` relative to
  `public/`.

## Workflow

- Conventional Commits. Squash-merge pull requests; the PR title becomes the
  release-notes line, so retitle before merging if needed.
- release-please owns the version: never bump `package.json` by hand and do
  not add a `CHANGELOG.md`. Merging the `chore: release x.y.z` PR tags,
  releases and publishes to npm (`.github/workflows/publish.yml`).
- No AI attribution in commits or PRs: no `Co-Authored-By`, no "Generated
  with".
- Before pushing: `npm run ci-lint`, `npm test`, and a local CodeRabbit
  review of the committed changes
  (`coderabbit review --agent --committed --base-commit $(git merge-base HEAD origin/main)`).
  Never push without explicit approval.
- To try a change on a real Signal K server: `npm pack`, install the tarball
  into the server's config directory with `npm install --ignore-scripts`,
  restart Signal K.
