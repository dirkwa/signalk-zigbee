import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  camelSegment,
  deviceMappings,
  devicePath,
  exposeMapping,
  flattenExposes,
  type Expose,
  type Z2mDevice,
} from "../src/exposes.js";

const snzb02d = JSON.parse(
  readFileSync(
    new URL("./fixtures/snzb02d-exposes.json", import.meta.url),
    "utf8",
  ),
) as { exposes: Expose[] };

/** Zigbee2MQTT appends link quality to every device's exposes. */
const LINKQUALITY: Expose = {
  type: "numeric",
  name: "linkquality",
  property: "linkquality",
  access: 1,
  unit: "lqi",
  category: "diagnostic",
};

const device: Z2mDevice = {
  ieee_address: "0x00124B0029FD1234",
  friendly_name: "Salon Klima",
  type: "EndDevice",
  definition: {
    model: "SNZB-02D",
    vendor: "SONOFF",
    exposes: [...snzb02d.exposes, LINKQUALITY],
  },
};

function byProperty(property: string) {
  const mapping = deviceMappings(device, "environment.inside.saloon").find(
    (m) => m.property === property,
  );
  if (mapping === undefined) throw new Error(`no mapping for ${property}`);
  return mapping;
}

describe("camelSegment", () => {
  it("camel-cases and transliterates", () => {
    expect(camelSegment("Kühlschrank links")).toBe("kuehlschrankLinks");
    expect(camelSegment("Salon Klima")).toBe("salonKlima");
    expect(camelSegment("0x00124b0029fd1234")).toBe("0x00124b0029fd1234");
    expect(camelSegment("bilge/aft-sensor")).toBe("bilgeAftSensor");
    expect(camelSegment("…")).toBe("unnamed");
  });
});

describe("devicePath", () => {
  it("fills every placeholder", () => {
    expect(devicePath("zigbee.{network}.{name}", "flybridge", device)).toBe(
      "zigbee.flybridge.salonKlima",
    );
    expect(devicePath("sensors.{ieee}", "main", device)).toBe(
      "sensors.0x00124b0029fd1234",
    );
  });
});

describe("flattenExposes", () => {
  it("descends into composite features", () => {
    const leaves = flattenExposes([
      {
        type: "switch",
        features: [
          { type: "binary", property: "state_l1", access: 7 },
          { type: "binary", property: "state_l2", access: 7 },
        ],
      },
      { type: "list", property: "schedule" },
      {
        type: "composite",
        property: "color",
        features: [
          { type: "numeric", property: "x", access: 7 },
          { type: "numeric", property: "y", access: 7 },
        ],
      },
    ]);
    expect(leaves.map((l) => l.property)).toEqual(["state_l1", "state_l2"]);
  });
});

describe("SNZB-02D", () => {
  it("maps every reported property under the base path", () => {
    expect(
      deviceMappings(device, "environment.inside.saloon").map((m) => m.path),
    ).toEqual([
      "environment.inside.saloon.battery",
      "environment.inside.saloon.temperature",
      "environment.inside.saloon.relativeHumidity",
      "environment.inside.saloon.comfortTemperatureMin",
      "environment.inside.saloon.comfortTemperatureMax",
      "environment.inside.saloon.comfortHumidityMin",
      "environment.inside.saloon.comfortHumidityMax",
      "environment.inside.saloon.temperatureUnits",
      "environment.inside.saloon.temperatureCalibration",
      "environment.inside.saloon.humidityCalibration",
      "environment.inside.saloon.linkQuality",
    ]);
  });

  it("converts readings to SI", () => {
    expect(byProperty("temperature").toSk(21.3)).toBeCloseTo(294.45, 6);
    expect(byProperty("temperature").meta.units).toBe("K");
    expect(byProperty("humidity").toSk(55.2)).toBeCloseTo(0.552, 6);
    expect(byProperty("humidity").meta.units).toBe("ratio");
    expect(byProperty("battery").toSk(100)).toBe(1);
  });

  it("treats calibration as a difference, not a reading", () => {
    const calibration = byProperty("temperature_calibration");
    expect(calibration.toSk(-1.5)).toBe(-1.5);
    expect(calibration.fromSk(0.5)).toBe(0.5);
    expect(byProperty("humidity_calibration").toSk(5)).toBeCloseTo(0.05, 6);
  });

  it("round-trips writable settings back to Zigbee2MQTT units", () => {
    const comfort = byProperty("comfort_temperature_max");
    expect(comfort.writable).toBe(true);
    expect(comfort.fromSk(299.15)).toBe(26);
    expect(byProperty("temperature").writable).toBe(false);
  });

  it("validates enum PUTs", () => {
    const units = byProperty("temperature_units");
    expect(units.fromSk("fahrenheit")).toBe("fahrenheit");
    expect(() => units.fromSk("kelvin")).toThrow(/celsius, fahrenheit/);
  });

  it("passes units without an SI counterpart through", () => {
    const lqi = byProperty("linkquality");
    expect(lqi.toSk(120)).toBe(120);
    expect(lqi.meta.units).toBe("lqi");
  });

  it("drops non-numeric samples of numeric properties", () => {
    expect(byProperty("temperature").toSk(null)).toBeUndefined();
    expect(byProperty("temperature").toSk("21")).toBeUndefined();
  });
});

describe("binary exposes", () => {
  const relay = exposeMapping(
    {
      type: "binary",
      property: "state",
      access: 7,
      value_on: "ON",
      value_off: "OFF",
    },
    "electrical.switches.anchorLight",
  );

  it("maps ON/OFF to booleans and back", () => {
    expect(relay.path).toBe("electrical.switches.anchorLight.state");
    expect(relay.toSk("ON")).toBe(true);
    expect(relay.toSk("OFF")).toBe(false);
    expect(relay.toSk("TOGGLE")).toBeUndefined();
    expect(relay.fromSk(true)).toBe("ON");
    expect(relay.fromSk(0)).toBe("OFF");
    expect(() => relay.fromSk("maybe")).toThrow();
  });
});

it("skips set-only properties that are never reported", () => {
  const mappings = deviceMappings(
    {
      ...device,
      definition: {
        exposes: [
          {
            type: "enum",
            property: "identify",
            access: 2,
            values: ["identify"],
          },
        ],
      },
    },
    "x",
  );
  expect(mappings).toEqual([]);
});
