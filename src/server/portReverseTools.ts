import { z } from "zod/v4";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";
import { defaultPortReverseManager } from "../features/portReverse/defaultPortReverseManager";
import { PortReverseError } from "../features/portReverse/PortReverseError";
import {
  PortReverseManager,
  type PortReverseProbeOption,
  type PortReverseResult,
  type PortReverseTarget,
} from "../features/portReverse/PortReverseManager";
import {
  assertPortsAllowed,
  portReversePolicyFromEnv,
  type PortReversePolicy,
} from "../features/portReverse/PortReversePolicy";
import { PortReverseRecoveryScheduler } from "../features/portReverse/PortReverseRecoveryScheduler";
import {
  PORT_REVERSE_RECONCILE_INTERVAL_MS,
  PortReversePeriodicReconciler,
} from "../features/portReverse/PortReversePeriodicReconciler";
import { ENV } from "../config/env";
import { readEnvInt } from "../utils/envNumbers";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../models";
import { createAdbReverseCommands } from "../utils/android-cmdline-tools/adbReverse";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  adbTransportRecoveredSignal,
  type AdbTransportRecoveredSignal,
} from "../utils/android-cmdline-tools/adbTransportRecoveredSignal";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  PROBE_HOST_HEADER_PATTERN,
  PROBE_PATH_PATTERN,
} from "../utils/android-cmdline-tools/portHttpProbe";
import {
  registerDeviceIncarnationListener,
  type DeviceIncarnationListener,
} from "../utils/deviceIncarnation";
import { defaultTimer } from "../utils/SystemTimer";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { defineDeviceTool, type DeviceToolHandler } from "./defineTool";
import { portReverseResultSchema } from "./portReverseToolOutputSchemas";

const port = z.number().int().min(1).max(65535);

const portReverseInput = z.object({
  action: z
    .enum(["ensure", "list", "verify", "remove"])
    .describe(
      "ensure: add missing mappings (idempotent). list: every reverse on the device. verify: " +
        "whether ports are mapped now. remove: delete mappings this session created",
    ),
  ports: z
    .array(
      z
        .object({
          devicePort: port.describe("Device-side localhost port"),
          hostPort: port.optional().describe("Host loopback port; default devicePort"),
        })
        .strict(),
    )
    .min(1)
    .max(32)
    .optional()
    .describe("Required for ensure and remove; verify defaults to this session's ports"),
  probe: z
    .union([
      z.boolean(),
      z
        .object({
          http: z
            .object({
              path: z
                .string()
                .max(512)
                .regex(PROBE_PATH_PATTERN)
                .describe("Request path sent from the device, e.g. /health"),
              expectStatus: z
                .array(z.number().int().min(100).max(599))
                .min(1)
                .max(16)
                .describe("Status codes that count as reachable"),
              hostHeader: z
                .string()
                .max(255)
                .regex(PROBE_HOST_HEADER_PATTERN)
                .optional()
                .describe("Host header; default localhost:<devicePort>"),
              expectBodyContains: z
                .string()
                .min(1)
                .max(256)
                .optional()
                .describe("Text the response body must contain"),
              timeoutMs: z
                .number()
                .int()
                .min(1000)
                .max(10000)
                .optional()
                .describe("Device-side wait for the response, whole seconds (default 2000)"),
            })
            .strict(),
        })
        .strict(),
    ])
    .optional()
    .describe(
      "verify only. true: connect to each mapped port from the device (about 1 s each, run " +
        "together) and report reachable, unreachable or probe_unsupported. {http}: send a GET " +
        "from the device through each mapping and check the status (and body); reports httpStatus " +
        "and probeReason http_status, http_body or no_http_response when it does not match",
    ),
  reclaimStale: z
    .boolean()
    .optional()
    .describe(
      "ensure only: replace a mapping no live session owns when its tcp: host port refuses a " +
        "loopback connect (needs a session that holds the device). The result marks it reclaimed",
    ),
});

type PortReverseAction = z.infer<typeof portReverseInput>["action"];

/** Sessionless calls share one holder; their mappings end with the device. */
export const SESSIONLESS_PORT_REVERSE_OWNER = "sessionless";

export interface PortReverseLifecycle {
  subscribeDeviceRemoval(listener: (deviceId: string) => void): () => void;
}

/**
 * Forgets the sessionless mappings on a device when it leaves the pool, without sending a command:
 * the removal event cannot tell a disconnect or relaunch (whose reverses died with the transport)
 * from identity replacement (another device now answers on the serial, and its mappings are not
 * ours). Session-owned mappings are released by the session's own release or unbind
 * (`registerPortReverseSessionCleanup`), not here: Android recovery removes and re-adds a device
 * while its session stays bound, and those mappings must survive to be restored after the relaunch.
 */
export function subscribePortReverseCleanup(
  lifecycle: PortReverseLifecycle,
  manager: Pick<PortReverseManager, "forgetOwnerOnDevice">,
): () => void {
  return lifecycle.subscribeDeviceRemoval(
    (deviceId) => void manager.forgetOwnerOnDevice(SESSIONLESS_PORT_REVERSE_OWNER, deviceId),
  );
}

export interface PortReverseToolDependencies {
  manager: PortReverseManager;
  policy: PortReversePolicy;
  adbFactory?: { create(device: BootedDevice): Pick<AdbExecutor, "executeCommand"> };
  /** The calling session; defaults to the routed session of the current tool call. */
  sessionUuid?: () => string | undefined;
}

const routedSessionUuid = () => {
  const context = getToolSelectionContext();
  // A tool-selection profile is not a session: nothing releases it, so it never owns mappings.
  return context?.routingSessionUuid;
};

function message(action: PortReverseAction, result: PortReverseResult): string {
  const restored = result.restored.length > 0 ? `; restored ${result.restored.join(", ")}` : "";
  const failed =
    result.restoreFailures.length > 0
      ? `; failed to restore ${result.restoreFailures.map((f) => f.devicePort).join(", ")}`
      : "";
  const summary = result.mappings.map((m) => `tcp:${m.devicePort} ${m.status}`).join(", ");
  return `portReverse ${action}: ${summary || "no mappings"}${restored}${failed}`;
}

async function run(
  manager: PortReverseManager,
  target: PortReverseTarget,
  args: {
    action: PortReverseAction;
    ports?: { devicePort: number; hostPort?: number }[];
    probe?: PortReverseProbeOption;
    reclaimStale?: boolean;
  },
  policy: PortReversePolicy,
): Promise<PortReverseResult> {
  const requests = (args.ports ?? []).map((p) => ({
    devicePort: p.devicePort,
    hostPort: p.hostPort ?? p.devicePort,
  }));
  if (args.action === "list") {
    return manager.list(target);
  }
  if (args.action === "verify") {
    return manager.verify(
      target,
      args.ports?.map((p) => p.devicePort),
      args.probe === undefined ? undefined : { probe: args.probe },
    );
  }
  if (requests.length === 0) {
    throw new PortReverseError(
      "port_reverse_port_refused",
      `portReverse ${args.action} needs ports: [{ devicePort, hostPort? }].`,
      [],
    );
  }
  if (args.action === "remove") {
    return manager.remove(
      target,
      requests.map((r) => r.devicePort),
    );
  }
  assertPortsAllowed(
    policy,
    requests.flatMap((r) => [r.devicePort, r.hostPort]),
  );
  return manager.ensure(target, requests, { reclaimStale: args.reclaimStale === true });
}

export function createPortReverseHandler(
  deps: PortReverseToolDependencies,
): DeviceToolHandler<typeof portReverseInput> {
  return async (device, args, _progress, signal) => {
    // A call its session's release aborted must not create mappings that release already missed.
    signal?.throwIfAborted();
    const base = { action: args.action, deviceId: device.deviceId };
    if (device.platform !== "android") {
      return createStructuredToolResponse({
        ...base,
        message:
          "portReverse is not needed on iOS: a simulator shares the host's network, so the app " +
          "reaches a host server at localhost:<port> directly. Physical iOS devices are not supported.",
        success: true,
        status: "not_applicable" as const,
      });
    }
    const session = args.sessionUuid ?? (deps.sessionUuid ?? routedSessionUuid)();
    const target: PortReverseTarget = {
      deviceId: device.deviceId,
      owner: session ?? SESSIONLESS_PORT_REVERSE_OWNER,
      adb: createAdbReverseCommands((deps.adbFactory ?? defaultAdbClientFactory).create(device)),
      // A session-routed call runs on the device bound to that session.
      holdsDevice: session !== undefined,
    };
    try {
      const result = await run(deps.manager, target, args, deps.policy);
      return createStructuredToolResponse({
        ...base,
        ...result,
        message: message(args.action, result),
        success: true,
        status: "ok" as const,
      });
    } catch (error) {
      if (!(error instanceof PortReverseError)) {
        throw error;
      }
      return withIsErrorOnFailure(
        createStructuredToolResponse({
          ...base,
          ...error.toPayload(),
          message: error.message,
          success: false,
          status: "failed" as const,
        }),
        false,
      );
    }
  };
}

const portReverseTool = defineDeviceTool({
  name: "portReverse",
  description:
    "Android: manage adb reverse mappings so the app or browser on the device reaches a host " +
    "server at localhost:<port>. ensure adds mappings this session owns; list, verify and remove " +
    "manage them. verify with probe:true also connects from the device to each mapped port: " +
    "reachable (the host server accepted), unreachable (probeReason closed: nothing listens on the " +
    "host; refused; timeout) or probe_unsupported; probe:{http:{path,expectStatus}} checks the " +
    "HTTP response instead. list reports hostListening for each tcp: host " +
    "port. ensure with reclaimStale:true replaces a stale mapping whose host port refuses. " +
    "Conflicts carry conflictKind. list and verify report each port's deviceListener. Owned mappings lost to an adb or device restart are restored on the next call " +
    "and removed when the session ends. Ports below 1024 are refused. iOS returns not_applicable.",
  input: portReverseInput,
  options: { defaultEnabled: false, outputSchema: portReverseResultSchema },
});

export const portReverseSchema = portReverseTool.schema;

/**
 * Re-applies a device's owned mappings when its adb transport recovers (an `adb reconnect`, a
 * refused command that later succeeded, a CtrlProxy reconnect), without waiting for a client call.
 */
export function subscribePortReverseTransportRecovery(
  signal: Pick<AdbTransportRecoveredSignal, "subscribe">,
  scheduler: Pick<PortReverseRecoveryScheduler, "deviceRecovered" | "cancel" | "dispose">,
  manager: Pick<PortReverseManager, "forgetDevice">,
  registerIdentityListener: (
    listener: DeviceIncarnationListener,
  ) => () => void = registerDeviceIncarnationListener,
): () => void {
  const unsubscribe = signal.subscribe((deviceId, reason) =>
    scheduler.deviceRecovered(deviceId, reason),
  );
  // Another device on the serial: its mappings are not ours, so nothing may be restored there.
  const unregister = registerIdentityListener({
    name: "port-reverse-recovery",
    onDeviceIdentityReplaced: (deviceId) => {
      scheduler.cancel(deviceId);
      manager.forgetDevice(deviceId);
    },
    onDeviceIncarnationChanged: () => undefined,
  });
  return () => {
    unsubscribe();
    unregister();
    scheduler.dispose();
  };
}

/**
 * Arms the periodic reconcile whenever an ensure leaves a device holding owned mappings, so a
 * mapping removed outside AutoMobile comes back without a client call (#17254).
 */
export function subscribePortReversePeriodicReconcile(
  manager: Pick<PortReverseManager, "onOwnedMappings">,
  reconciler: Pick<PortReversePeriodicReconciler, "wake" | "dispose">,
): () => void {
  const unsubscribe = manager.onOwnedMappings(() => reconciler.wake());
  return () => {
    unsubscribe();
    void reconciler.dispose();
  };
}

/** `AUTOMOBILE_PORT_REVERSE_RECONCILE_INTERVAL_MS`, or the default when unset or invalid. */
export function portReverseReconcileIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return readEnvInt(ENV.PORT_REVERSE_RECONCILE_INTERVAL_MS, env, {
    fallback: PORT_REVERSE_RECONCILE_INTERVAL_MS,
  });
}

let daemonSubscribed = false;

function daemonManager(): PortReverseManager {
  if (!daemonSubscribed) {
    daemonSubscribed = true;
    subscribePortReverseCleanup(
      { subscribeDeviceRemoval: (l) => getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved(l) },
      defaultPortReverseManager,
    );
    subscribePortReverseTransportRecovery(
      adbTransportRecoveredSignal,
      new PortReverseRecoveryScheduler({ manager: defaultPortReverseManager, timer: defaultTimer }),
      defaultPortReverseManager,
    );
    subscribePortReversePeriodicReconcile(
      defaultPortReverseManager,
      new PortReversePeriodicReconciler({
        manager: defaultPortReverseManager,
        timer: defaultTimer,
        intervalMs: portReverseReconcileIntervalFromEnv(),
      }),
    );
  }
  return defaultPortReverseManager;
}

export function registerPortReverseTools(deps?: PortReverseToolDependencies): void {
  portReverseTool.register(
    undefined,
    createPortReverseHandler(
      deps ?? { manager: daemonManager(), policy: portReversePolicyFromEnv() },
    ),
  );
}
