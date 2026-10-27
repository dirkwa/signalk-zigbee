import { describe, expect, it } from "vitest";
import {
  applyDefaults,
  validate,
  Z2M_ESPOS_IMAGE,
  Z2M_OFFICIAL_DEFAULT_TAG,
  Z2M_OFFICIAL_IMAGE,
  z2mImage,
} from "../src/config.js";

const USB =
  "/dev/serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_x-if00-port0";

describe("applyDefaults", () => {
  it("fills an empty config", () => {
    expect(applyDefaults({})).toEqual({
      brokerPort: 1883,
      mosquittoTag: "2.0.22",
      pathTemplate: "zigbee.{network}.{name}",
      networks: [],
      devices: [],
    });
  });

  it("gives each network its own default frontend port", () => {
    const settings = applyDefaults({
      networks: [
        { serialPort: USB },
        { coordinator: "espos", esposAddress: "10.0.0.5" },
      ],
    });
    expect(settings.networks.map((n) => [n.id, n.frontendPort])).toEqual([
      ["main", 8099],
      ["net2", 8100],
    ]);
  });

  it("forces zboss for espOS coordinators", () => {
    const [net] = applyDefaults({
      networks: [{ coordinator: "espos", adapter: "ember", esposAddress: "x" }],
    }).networks;
    expect(net?.adapter).toBe("zboss");
  });

  it("normalises device overrides", () => {
    expect(
      applyDefaults({
        devices: [
          { ieeeAddress: "0x00124B0029FD1234", basePath: "a.b" },
          { basePath: "c" },
        ],
      }).devices,
    ).toEqual([
      { ieeeAddress: "0x00124b0029fd1234", basePath: "a.b", enabled: true },
    ]);
  });
});

describe("z2mImage", () => {
  it("picks the image by coordinator kind unless overridden", () => {
    const [usb, espos, custom] = applyDefaults({
      networks: [
        { serialPort: USB },
        { coordinator: "espos", esposAddress: "x" },
        { coordinator: "espos", esposAddress: "y", image: Z2M_OFFICIAL_IMAGE },
      ],
    }).networks;
    expect(z2mImage(usb!)).toEqual({
      image: Z2M_OFFICIAL_IMAGE,
      tag: Z2M_OFFICIAL_DEFAULT_TAG,
    });
    expect(z2mImage(espos!)).toEqual({ image: Z2M_ESPOS_IMAGE, tag: "latest" });
    expect(z2mImage(custom!)).toEqual({
      image: Z2M_OFFICIAL_IMAGE,
      tag: Z2M_OFFICIAL_DEFAULT_TAG,
    });
  });
});

describe("validate", () => {
  it("accepts a USB and an espOS network side by side", () => {
    expect(
      validate(
        applyDefaults({
          networks: [
            { serialPort: USB },
            { coordinator: "espos", esposAddress: "zb-gw" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("reports every unusable setting", () => {
    const problems = validate(
      applyDefaults({
        networks: [
          { id: "Main", serialPort: "COM3" },
          { id: "Main", coordinator: "espos", frontendPort: 1883 },
        ],
      }),
    );
    expect(problems).toEqual([
      'Network id "Main" must be lowercase letters, digits and dashes.',
      'Network "Main" needs the serial port of its USB coordinator.',
      'Network id "Main" must be lowercase letters, digits and dashes.',
      'Network id "Main" is used twice.',
      'Network "Main" uses port 1883, which the broker already uses.',
      'Network "Main" needs the address or mDNS name of its espOS coordinator.',
    ]);
  });

  it("ignores disabled networks beyond their id", () => {
    expect(validate(applyDefaults({ networks: [{ enabled: false }] }))).toEqual(
      [],
    );
  });
});
