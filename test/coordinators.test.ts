import { describe, expect, it } from "vitest";
import { findSticks, identifyCoordinator } from "../src/coordinators.js";

const BY_ID = "/dev/serial/by-id/";

describe("identifyCoordinator", () => {
  it.each([
    [
      "usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_b8b49abd27a6ed11a280eba32981d111-if00-port0",
      "zstack",
    ],
    [
      "usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_a6ee897e4d1fef11aa004ad0639e525b-if00-port0",
      "ember",
    ],
    [
      "usb-SONOFF_SONOFF_Dongle_Max_MG24_08965d6b0674ef11b2f4e61e313510fd-if00-port0",
      "ember",
    ],
    [
      "usb-SONOFF_SONOFF_Dongle_Plus_CC2674P10_141ff85f6b12f011b6500514773d9da9-if00-port0",
      "zstack",
    ],
    [
      "usb-dresden_elektronik_ingenieurtechnik_GmbH_ConBee_II_DE2132111-if00",
      "deconz",
    ],
    [
      "usb-Nabu_Casa_SkyConnect_v1.0_3abe54797c91ed118fc3cad13b20a111-if00-port0",
      "ember",
    ],
    ["usb-Nabu_Casa_ZBT-2_10B41DE58D6C-if00", "ember"],
    [
      "usb-SMLIGHT_SMLIGHT_SLZB-06p7_82e43faf9872ed118bb924f3fdf7b791-if00-port0",
      "zstack",
    ],
    ["usb-ZEPHYR_Zigbee_NCP_54ACCFAFA6DAD111-if00", "zboss"],
    ["usb-FTDI_ZiGate_ZIGATE+-if00-port0", "zigate"],
    [
      "usb-Texas_Instruments_TI_CC2531_USB_CDC___0X00124B0018ED1111-if00",
      "zstack",
    ],
  ])("recognises %s", (name, adapter) => {
    expect(identifyCoordinator(BY_ID + name)).toBe(adapter);
  });

  it.each([
    "usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0",
    "usb-u-blox_AG_-_www.u-blox.com_u-blox_GNSS_receiver-if00",
    "usb-Actisense_NGT-1_12345-if00-port0",
  ])("ignores %s", (name) => {
    expect(identifyCoordinator(BY_ID + name)).toBeUndefined();
  });
});

describe("findSticks", () => {
  it("keeps the coordinators with their driver, in order", () => {
    expect(
      findSticks([
        `${BY_ID}usb-Actisense_NGT-1_12345-if00-port0`,
        `${BY_ID}usb-dresden_elektronik_ConBee_III_DE03188111-if00-port0`,
      ]),
    ).toEqual([
      {
        serialPort: `${BY_ID}usb-dresden_elektronik_ConBee_III_DE03188111-if00-port0`,
        adapter: "deconz",
      },
    ]);
  });

  // deCONZ runs the original ConBee at 38400, not the default 115200.
  it("gives an original ConBee its serial speed", () => {
    const serialPort = `${BY_ID}usb-dresden_elektronik_ingenieurtechnik_GmbH_ConBee_DE1234567-if00-port0`;
    expect(findSticks([serialPort])).toEqual([
      { serialPort, adapter: "deconz", baudrate: 38400 },
    ]);
  });

  it("finds nothing among other serial devices", () => {
    expect(findSticks([`${BY_ID}usb-FTDI_GPS-if00-port0`])).toEqual([]);
  });
});
