# v0.1.0

First release.

- Runs Mosquitto and one Zigbee2MQTT container per coordinator through
  signalk-container.
- USB coordinators on the Signal K host and espOS coordinators on the
  network (`zboss` over TCP, found through mDNS). The Zigbee2MQTT image is
  selectable per network; espOS networks default to the patched
  `ghcr.io/tostmann/zigbee2mqtt-esp32`.
- Every paired device is mapped to Signal K paths from Zigbee2MQTT's device
  definitions, with SI units and metadata. Writable settings accept PUT.
- Web app with network status, device list, pairing button, device
  renaming and links to each Zigbee2MQTT interface.
