# signalk-zigbee

Zigbee sensors, switches and plugs in Signal K, through
[Zigbee2MQTT](https://www.zigbee2mqtt.io).

The plugin runs Mosquitto and Zigbee2MQTT as managed containers via
[signalk-container](https://github.com/dirkwa/signalk-container). Every
device you pair is mapped to Signal K paths automatically, from
Zigbee2MQTT's own device definitions: values arrive in SI units with
metadata, and writable device settings accept Signal K PUT requests. There
is no per-device configuration to write.

## Coordinators

A coordinator is the radio that forms a Zigbee network. Two kinds are
supported:

- **A USB stick on the Signal K host**, e.g. Sonoff ZBDongle-E/-P, Home
  Assistant SkyConnect/ZBT-1, or a compatible clone.
- **An espOS device on the network**, reached by Zigbee2MQTT at
  `tcp://<ip>:6638` with the `zboss` adapter.

Zigbee2MQTT drives exactly one coordinator, so the plugin starts one
Zigbee2MQTT container per coordinator. Each coordinator forms its own Zigbee
network; a device is paired to one of them. Networks are not merged.

## Requirements

- Signal K server with [signalk-container](https://www.npmjs.com/package/signalk-container) 1.37 or later
  and rootless Podman or Docker.
- Signal K running on the host network: bare metal, or the
  [universal installer](https://github.com/dirkwa/signalk-universal-installer)
  container. Mosquitto and Zigbee2MQTT use host networking and are reached on
  `127.0.0.1`.
- A USB coordinator can be plugged in while Signal K runs, also in a
  containerized Signal K: signalk-container passes the stick from the host
  to Zigbee2MQTT. Restart the plugin after plugging it in. This works for
  `/dev/serial/by-id/…`, `/dev/serial/by-path/…`, `/dev/ttyUSB*` and
  `/dev/ttyACM*`; any other name must first be passed to the Signal K
  container (universal installer: `signalk hardware rescan`).

## Configuration

Server → Plugin Config → Zigbee (Zigbee2MQTT). Add one entry under
**Zigbee networks** per coordinator:

| Field              | USB                                     | espOS                                         |
| ------------------ | --------------------------------------- | --------------------------------------------- |
| Network id         | short name, e.g. `main`                 | e.g. `flybridge`                              |
| Coordinator        | USB stick on this host                  | espOS device on the network                   |
| Serial port        | `/dev/serial/by-id/…` (survives replug) | —                                             |
| Adapter driver     | `ember` (EFR32), `zstack` (CC26xx), …   | always `zboss`                                |
| espOS coordinator  | —                                       | IPv4 address, hostname, mDNS name or espOS id |
| Zigbee2MQTT image  | empty: official image                   | empty: `ghcr.io/tostmann/zigbee2mqtt-esp32`   |
| Web interface port | 8099, 8100, … per network               | same                                          |
| Zigbee channel     | only used when the network is formed    | same                                          |

The default image for espOS coordinators is the patched
`ghcr.io/tostmann/zigbee2mqtt-esp32`: it has longer timeouts for the TCP link
and supports coordinator backup and restore. The official
`ghcr.io/koenkk/zigbee2mqtt` image also works with espOS coordinators and can
be chosen per network.

An espOS coordinator accepts a single TCP connection, which Zigbee2MQTT
holds. The plugin therefore never connects to it itself: it finds the
coordinator through mDNS (service `_espos-zigbee._tcp`) and restarts
that network's Zigbee2MQTT when the coordinator announces a new address.
Coordinators seen on mDNS that no network uses yet are listed in the plugin
status and in the web app.

### Web interface access

Host networking puts each Zigbee2MQTT web interface on the LAN, where it
would give anyone full control of that Zigbee network. The plugin therefore
generates an access token per network, kept in
`plugin-config-data/signalk-zigbee/networks/<id>/frontend-token`. The links
in the Zigbee web app carry the token when you are logged in to Signal K as
an admin; anyone else is asked for it by Zigbee2MQTT.

### Pairing

Open the **Zigbee** web app, press **Allow pairing** on a network, then put
the device into pairing mode (on most Sonoff sensors: hold the button for
five seconds). A new device is named after its IEEE address; admins can
**Rename** it right in the device list. The full Zigbee2MQTT interface is
linked from the same page, for OTA updates and the network map.

## Signal K paths

By default a device lands under `zigbee.<network>.<name>`, where `<name>` is
its Zigbee2MQTT friendly name in camelCase (`TEMP internal` becomes
`tempInternal`). Rename the device (in the Zigbee
web app or in Zigbee2MQTT) and the paths follow; values under the old path
stay in the Data Browser until Signal K restarts. The template is configurable (`{network}`, `{name}`,
`{ieee}`), and **Per-device paths** gives a single device a meaningful place
by its IEEE address, e.g. `environment.inside.saloon`.

Each property becomes one leaf, named after the Zigbee2MQTT property in
camelCase; `humidity` becomes `relativeHumidity` and `linkquality`
`linkQuality`. A SONOFF SNZB-02D with base path `environment.inside.saloon`:

| Path                                                  | Units | PUT |
| ----------------------------------------------------- | ----- | --- |
| `environment.inside.saloon.temperature`               | K     |     |
| `environment.inside.saloon.relativeHumidity`          | ratio |     |
| `environment.inside.saloon.battery`                   | ratio |     |
| `environment.inside.saloon.linkQuality`               | ratio |     |
| `environment.inside.saloon.comfortTemperatureMin/Max` | K     | yes |
| `environment.inside.saloon.comfortHumidityMin/Max`    | ratio | yes |
| `environment.inside.saloon.temperatureUnits`          |       | yes |
| `environment.inside.saloon.temperatureCalibration`    | K     | yes |
| `environment.inside.saloon.humidityCalibration`       | ratio | yes |

Units are converted to SI: °C → K, % → ratio, hPa → Pa, mV → V, kWh → J and
so on. Calibration and offset values are treated as differences (+1 °C is
+1 K). Link quality (LQI, 0 to 255) becomes a ratio of the best link. The
Data Browser of Signal K 2.19 and later draws it as a bar that is green from
about LQI 100, yellow from about 50 and red below; older servers show the
ratio as a number. Units without an SI counterpart (lx, ppm) pass
through unchanged and are named in the path metadata. On/off values become
`true`/`false`.
Composite and list properties (a light's `color` with its `x`/`y`, a
schedule, the OTA `update` block) are not mapped; use the Zigbee2MQTT
interface for those.

A PUT is converted back to Zigbee2MQTT's units and sent as a `/set` request.
Battery-powered sensors only listen right after they wake up: press the
device's button before changing one of its settings.

## How it runs

| Container             | Image               | Purpose                            |
| --------------------- | ------------------- | ---------------------------------- |
| `sk-zigbee-mosquitto` | `eclipse-mosquitto` | MQTT broker on `127.0.0.1:1883`    |
| `sk-zigbee2mqtt-<id>` | per network         | one Zigbee network per coordinator |

Data lives in the plugin's data directory
(`plugin-config-data/signalk-zigbee/`): the broker's persistence and one
directory per network with Zigbee2MQTT's `configuration.yaml`, database and
coordinator backup. Back this directory up; it holds the network keys.

The plugin writes `configuration.yaml` only when a network is new. Everything
it controls (broker, coordinator, adapter, base topic, web port) is passed to
Zigbee2MQTT as environment overrides, so changes you make in the
Zigbee2MQTT interface are kept. Each network publishes under the MQTT base
topic `zigbee2mqtt-<id>`.

Two Zigbee2MQTT options are switched on through its options API, because a
sensor may report only once an hour: `device_options.retain`, so the broker
keeps each device's last state, and `advanced.last_seen` (ISO 8601), the
time of the device's last message. After a Signal K restart the paths are
filled again right away, stamped with that time rather than the restart.

Disabling the plugin stops the containers; re-enabling starts them again
without a pull. Removing or disabling a network stops its container.

## Development

```bash
npm install
npm test          # typecheck + vitest
npm run build     # tsc → dist/
npm run format    # prettier + eslint --fix
npm run ci-lint   # what CI runs
```

release-please cuts releases; never bump `package.json`'s version by hand.
Squash-merge pull requests with a Conventional Commit title: `feat` gives a
minor release, `fix`, `perf` or `revert` a patch, and `!` or a
`BREAKING CHANGE:` footer a major one. release-please keeps a
`chore: release x.y.z` pull request open; merging it tags the release,
creates the GitHub Release and publishes to npm through trusted publishing,
all in `.github/workflows/publish.yml`. The release notes are generated from
the merged pull requests, grouped by the labels `label-by-title.yml` sets
from their titles.

## License

Apache-2.0
