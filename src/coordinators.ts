/**
 * Recognising a Zigbee coordinator stick by its /dev/serial/by-id name.
 *
 * udev names the link after the stick's USB vendor and product strings, so
 * the name alone tells a coordinator from a GPS or an NMEA adapter, and which
 * Zigbee2MQTT adapter driver it needs. The patterns follow zigbee-herdsman's
 * USB adapter discovery (MIT, Koen Kanters et al.), reduced to the name: the
 * vendor and product ids it also uses are not visible from here.
 */

import type { Adapter } from "./config.js";

interface Pattern {
  re: RegExp;
  adapter: Adapter;
}

/** First match wins: the specific Sonoff names come before the generic one. */
const PATTERNS: readonly Pattern[] = [
  { re: /conbee/i, adapter: "deconz" },
  { re: /zigate/i, adapter: "zigate" },
  { re: /zephyr_zigbee_ncp/i, adapter: "zboss" },
  { re: /nabu_casa_(skyconnect|.*zbt-[12])/i, adapter: "ember" },
  { re: /slzb-07mg24|slzb-06m|slzb-07_/i, adapter: "ember" },
  { re: /slzb-0[67]p\d+/i, adapter: "zstack" },
  { re: /sonoff.*(cc2674p10)/i, adapter: "zstack" },
  { re: /sonoff.*(plus_v2_|max|mg2[14])/i, adapter: "ember" },
  // ZBDongle-P (CC2652P). An early ZBDongle-E batch shares this name; the
  // driver can be changed in the plugin configuration.
  { re: /sonoff.*plus/i, adapter: "zstack" },
  { re: /electrolama|slae\.sh_cc2652rb|tubeszb|zigstar/i, adapter: "zstack" },
  { re: /cc253[18]|texas_instruments/i, adapter: "zstack" },
];

/** The adapter driver for a known coordinator, or undefined. */
export function identifyCoordinator(byIdPath: string): Adapter | undefined {
  const name = byIdPath.slice(byIdPath.lastIndexOf("/") + 1);
  return PATTERNS.find((p) => p.re.test(name))?.adapter;
}

/** A Zigbee coordinator stick found on the host. */
export interface UsbStick {
  serialPort: string;
  adapter: Adapter;
}

/** The known coordinators among the host's serial device paths. */
export function findSticks(paths: readonly string[]): UsbStick[] {
  return paths.flatMap((serialPort) => {
    const adapter = identifyCoordinator(serialPort);
    return adapter === undefined ? [] : [{ serialPort, adapter }];
  });
}
