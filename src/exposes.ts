/**
 * Zigbee2MQTT device definitions → Signal K paths.
 *
 * Zigbee2MQTT describes every device it supports with "exposes": typed
 * properties with units and access flags. This module turns them into path
 * mappings with SI conversion in both directions. It is pure, so all of the
 * naming and unit rules are unit-tested without a broker.
 */

/** Zigbee2MQTT access bits. */
export const ACCESS_STATE = 0b001;
export const ACCESS_SET = 0b010;

export interface Expose {
  type: string;
  property?: string;
  name?: string;
  label?: string;
  description?: string;
  unit?: string;
  access?: number;
  category?: string;
  value_on?: unknown;
  value_off?: unknown;
  values?: unknown[];
  features?: Expose[];
}

export interface Z2mDevice {
  ieee_address: string;
  friendly_name: string;
  type: string;
  disabled?: boolean;
  supported?: boolean;
  definition?: {
    model?: string;
    vendor?: string;
    description?: string;
    exposes?: Expose[];
  } | null;
}

export interface PathMeta {
  displayName: string;
  description?: string;
  units?: string;
}

export interface PathMapping {
  /** Key in the device's state payload. */
  property: string;
  path: string;
  meta: PathMeta;
  writable: boolean;
  /** Zigbee2MQTT value → Signal K value; undefined drops the sample. */
  toSk(value: unknown): unknown;
  /** Signal K value → Zigbee2MQTT value; throws on invalid input. */
  fromSk(value: unknown): unknown;
}

const LEAF_TYPES = new Set(["numeric", "binary", "enum", "text"]);

/**
 * Every top-level leaf property. Specific exposes (switch, light, climate …)
 * are flattened into their features; composites are skipped.
 */
export function flattenExposes(exposes: readonly Expose[]): Expose[] {
  const leaves: Expose[] = [];
  const walk = (list: readonly Expose[]) => {
    for (const expose of list) {
      // A composite's features are nested under its own property in the
      // state payload ({"color": {"x": …}}), not top-level keys.
      if (expose.type === "composite") continue;
      if (Array.isArray(expose.features) && expose.features.length > 0) {
        walk(expose.features);
      } else if (
        LEAF_TYPES.has(expose.type) &&
        typeof expose.property === "string" &&
        expose.property !== ""
      ) {
        leaves.push(expose);
      }
    }
  };
  walk(exposes);
  return leaves;
}

const TRANSLITERATIONS: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "Ae",
  Ö: "Oe",
  Ü: "Ue",
  ß: "ss",
};

/** "Kühlschrank links" → "kuehlschrankLinks"; a single safe path segment. */
export function camelSegment(text: string): string {
  const ascii = text
    .replace(/[äöüÄÖÜß]/g, (ch) => TRANSLITERATIONS[ch] ?? ch)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  const words = ascii.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  const camel = words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
  return camel === "" ? "unnamed" : camel;
}

/** Property names that have an established Signal K spelling. */
const LEAF_NAMES: Record<string, string> = {
  humidity: "relativeHumidity",
  linkquality: "linkQuality",
  co2: "carbonDioxide",
  voc: "volatileOrganicCompounds",
};

export function leafName(property: string): string {
  return LEAF_NAMES[property] ?? camelSegment(property);
}

export function devicePath(
  template: string,
  network: string,
  device: Pick<Z2mDevice, "friendly_name" | "ieee_address">,
): string {
  return template
    .replaceAll("{network}", camelSegment(network))
    .replaceAll("{name}", camelSegment(device.friendly_name))
    .replaceAll("{ieee}", device.ieee_address.toLowerCase());
}

interface Conversion {
  units?: string;
  scale: number;
  /** Added after scaling for absolute values; offsets ignore it. */
  offset: number;
}

const CONVERSIONS: Record<string, Conversion> = {
  "°C": { units: "K", scale: 1, offset: 273.15 },
  "°F": { units: "K", scale: 5 / 9, offset: 273.15 - (32 * 5) / 9 },
  "%": { units: "ratio", scale: 0.01, offset: 0 },
  Pa: { units: "Pa", scale: 1, offset: 0 },
  hPa: { units: "Pa", scale: 100, offset: 0 },
  kPa: { units: "Pa", scale: 1000, offset: 0 },
  mbar: { units: "Pa", scale: 100, offset: 0 },
  bar: { units: "Pa", scale: 100_000, offset: 0 },
  V: { units: "V", scale: 1, offset: 0 },
  mV: { units: "V", scale: 0.001, offset: 0 },
  A: { units: "A", scale: 1, offset: 0 },
  mA: { units: "A", scale: 0.001, offset: 0 },
  W: { units: "W", scale: 1, offset: 0 },
  kW: { units: "W", scale: 1000, offset: 0 },
  Wh: { units: "J", scale: 3600, offset: 0 },
  kWh: { units: "J", scale: 3_600_000, offset: 0 },
  Hz: { units: "Hz", scale: 1, offset: 0 },
  ms: { units: "s", scale: 0.001, offset: 0 },
  s: { units: "s", scale: 1, offset: 0 },
  min: { units: "s", scale: 60, offset: 0 },
  h: { units: "s", scale: 3600, offset: 0 },
  mm: { units: "m", scale: 0.001, offset: 0 },
  cm: { units: "m", scale: 0.01, offset: 0 },
  m: { units: "m", scale: 1, offset: 0 },
};

/**
 * Calibration values are differences, not readings: +1 °C of calibration is
 * +1 K, not 274.15 K.
 */
function isOffsetProperty(property: string): boolean {
  return /calibration|offset/i.test(property);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Scaling leaves binary noise (57.1 % → 0.5710000000000001); twelve
 * significant digits are far beyond any Zigbee sensor's resolution.
 */
const SK_PRECISION = 12;

function numericMapping(
  expose: Expose,
): Pick<PathMapping, "toSk" | "fromSk"> & { units?: string } {
  const conversion =
    expose.unit !== undefined ? CONVERSIONS[expose.unit] : undefined;
  if (conversion === undefined) {
    // Units without an SI counterpart (lx, ppm, dBm …) pass through as-is.
    return {
      units: expose.unit,
      toSk: finite,
      fromSk: (value) => {
        const n = finite(value);
        if (n === undefined) throw new Error("expected a number");
        return n;
      },
    };
  }
  const offset = isOffsetProperty(expose.property ?? "")
    ? 0
    : conversion.offset;
  return {
    units: conversion.units,
    toSk: (value) => {
      const n = finite(value);
      return n === undefined
        ? undefined
        : Number((n * conversion.scale + offset).toPrecision(SK_PRECISION));
    },
    fromSk: (value) => {
      const n = finite(value);
      if (n === undefined) throw new Error("expected a number");
      // Zigbee2MQTT rejects long fractions on some attributes.
      return Number(((n - offset) / conversion.scale).toFixed(6));
    },
  };
}

function binaryMapping(expose: Expose): Pick<PathMapping, "toSk" | "fromSk"> {
  const on = expose.value_on ?? true;
  const off = expose.value_off ?? false;
  return {
    toSk: (value) => (value === on ? true : value === off ? false : undefined),
    fromSk: (value) => {
      if (value === true || value === 1 || value === on) return on;
      if (value === false || value === 0 || value === off) return off;
      throw new Error("expected true or false");
    },
  };
}

function enumMapping(expose: Expose): Pick<PathMapping, "toSk" | "fromSk"> {
  const values = Array.isArray(expose.values) ? expose.values : [];
  return {
    toSk: (value) => (value === null ? undefined : value),
    fromSk: (value) => {
      if (values.length > 0 && !values.includes(value)) {
        throw new Error(`expected one of ${values.join(", ")}`);
      }
      return value;
    },
  };
}

const passthrough: Pick<PathMapping, "toSk" | "fromSk"> = {
  toSk: (value) => (value === null ? undefined : value),
  fromSk: (value) => value,
};

export function exposeMapping(expose: Expose, basePath: string): PathMapping {
  const property = expose.property as string;
  const access = expose.access ?? ACCESS_STATE;
  let conversion: Pick<PathMapping, "toSk" | "fromSk"> & { units?: string };
  switch (expose.type) {
    case "numeric":
      conversion = numericMapping(expose);
      break;
    case "binary":
      conversion = binaryMapping(expose);
      break;
    case "enum":
      conversion = enumMapping(expose);
      break;
    default:
      conversion = passthrough;
  }
  const meta: PathMeta = {
    displayName: expose.label ?? property,
  };
  if (expose.description !== undefined) meta.description = expose.description;
  if (conversion.units !== undefined) meta.units = conversion.units;
  return {
    property,
    path: `${basePath}.${leafName(property)}`,
    meta,
    writable: (access & ACCESS_SET) !== 0,
    toSk: conversion.toSk,
    fromSk: conversion.fromSk,
  };
}

/**
 * Mappings for one device. Properties that are only settable (no state
 * flag) are skipped: Zigbee2MQTT never reports them, so a Signal K path for
 * them would stay empty forever.
 */
export function deviceMappings(
  device: Z2mDevice,
  basePath: string,
): PathMapping[] {
  const exposes = device.definition?.exposes ?? [];
  const seen = new Set<string>();
  const mappings: PathMapping[] = [];
  for (const expose of flattenExposes(exposes)) {
    const access = expose.access ?? ACCESS_STATE;
    if ((access & ACCESS_STATE) === 0) continue;
    const mapping = exposeMapping(expose, basePath);
    if (seen.has(mapping.path)) continue;
    seen.add(mapping.path);
    mappings.push(mapping);
  }
  return mappings;
}
