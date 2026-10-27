/**
 * signalk-zigbee — Zigbee devices in Signal K through Zigbee2MQTT.
 *
 * Runs Mosquitto and one Zigbee2MQTT container per coordinator (a local USB
 * stick or an espOS device on the network) via signalk-container, and maps
 * every paired device to Signal K paths from Zigbee2MQTT's own device
 * definitions. Writable device settings accept Signal K PUTs.
 */

import type { Plugin, ServerAPI } from "@signalk/server-api";
import { errMsg, type StopOptions } from "signalk-container-helper";
import {
  applyDefaults,
  CONFIG_SCHEMA,
  PLUGIN_ID,
  UI_SCHEMA,
} from "./config.js";
import { ZigbeeRunner } from "./runner.js";

interface RequestLike {
  params: Record<string, string>;
  body?: unknown;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

type Handler = (req: RequestLike, res: ResponseLike) => unknown;

interface PluginRouter {
  get(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
  /** Permission registrar (Signal K ≥ 2.x); feature-detect. */
  access?(level: "readonly" | "readwrite"): PluginRouter;
}

/** Zigbee2MQTT's longest permit-join window. */
const MAX_PERMIT_JOIN_S = 254;

export default function createPlugin(app: ServerAPI): Plugin {
  // Kept for the process lifetime: registerWithRouter runs once, even while
  // the plugin is disabled, and Express routes cannot be removed.
  const runner = new ZigbeeRunner(app);

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: "Zigbee (Zigbee2MQTT)",
    description:
      "Zigbee sensors and switches via Zigbee2MQTT, with USB or espOS " +
      "coordinators, mapped to Signal K paths automatically.",

    schema: () => CONFIG_SCHEMA as unknown as object,
    uiSchema: () => UI_SCHEMA as unknown as object,

    start(config: object) {
      runner.start(applyDefaults((config ?? {}) as Record<string, unknown>));
    },

    async stop(options?: StopOptions) {
      await runner.stop(options);
    },

    registerWithRouter(router: unknown) {
      const pluginRouter = router as PluginRouter;
      const readonly =
        typeof pluginRouter.access === "function"
          ? pluginRouter.access("readonly")
          : pluginRouter;

      // GET /plugins/signalk-zigbee/api/status
      readonly.get("/api/status", (_req, res) => {
        res.json(runner.status());
      });

      // GET /plugins/signalk-zigbee/api/frontend-tokens — admin only: each
      // token unlocks full control of a Zigbee network.
      pluginRouter.get("/api/frontend-tokens", (_req, res) => {
        res.json(runner.frontendTokens());
      });

      // POST /plugins/signalk-zigbee/api/networks/:id/permit-join
      // body: { "seconds": 0..254 }, default 254; 0 closes pairing.
      pluginRouter.post("/api/networks/:id/permit-join", (req, res) => {
        if (!runner.isRunning) {
          res.status(503).json({ error: `${PLUGIN_ID} is not running` });
          return;
        }
        const requested = (req.body as { seconds?: unknown } | undefined)
          ?.seconds;
        const seconds =
          typeof requested === "number" && Number.isInteger(requested)
            ? Math.min(Math.max(requested, 0), MAX_PERMIT_JOIN_S)
            : MAX_PERMIT_JOIN_S;
        runner.permitJoin(req.params.id ?? "", seconds).then(
          () => res.json({ network: req.params.id, seconds }),
          (err: unknown) => res.status(502).json({ error: errMsg(err) }),
        );
      });
    },
  };

  return plugin;
}
