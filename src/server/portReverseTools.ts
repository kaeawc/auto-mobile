import { z } from "zod/v4";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";
import { defaultPortReverseManager } from "../features/portReverse/defaultPortReverseManager";
import { PortReverseError } from "../features/portReverse/PortReverseError";
import {
  PortReverseManager,
  type PortReverseResult,
  type PortReverseTarget,
} from "../features/portReverse/PortReverseManager";
import {
  assertPortsAllowed,
  portReversePolicyFromEnv,
  type PortReversePolicy,
} from "../features/portReverse/PortReversePolicy";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../models";
import { createAdbReverseCommands } from "../utils/android-cmdline-tools/adbReverse";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
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
      z.object({
        devicePort: port.describe("Device-side localhost port"),
        hostPort: port.optional().describe("Host loopback port; default devicePort"),
      }),
    )
    .min(1)
    .max(32)
    .optional()
    .describe("Required for ensure and remove; verify defaults to this session's ports"),
});

type PortReverseAction = z.infer<typeof portReverseInput>["action"];

/** Sessionless calls share one holder; their mappings end with the device. */
export const SESSIONLESS_PORT_REVERSE_OWNER = "sessionless";

export interface PortReverseLifecycle {
  subscribeDeviceRemoval(listener: (deviceId: string) => void): () => void;
}

/**
 * Releases the sessionless mappings on a device when it leaves the pool. Session-owned mappings are
 * released by the session's own release or unbind (`registerPortReverseSessionCleanup`), not here:
 * Android recovery removes and re-adds a device while its session stays bound, and those mappings
 * must survive to be restored after the relaunch.
 */
export function subscribePortReverseCleanup(
  lifecycle: PortReverseLifecycle,
  manager: Pick<PortReverseManager, "releaseOwnerOnDevice">,
): () => void {
  return lifecycle.subscribeDeviceRemoval(
    (deviceId) => void manager.releaseOwnerOnDevice(SESSIONLESS_PORT_REVERSE_OWNER, deviceId),
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
  args: { action: PortReverseAction; ports?: { devicePort: number; hostPort?: number }[] },
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
  return manager.ensure(target, requests);
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
    const target: PortReverseTarget = {
      deviceId: device.deviceId,
      owner:
        args.sessionUuid ??
        (deps.sessionUuid ?? routedSessionUuid)() ??
        SESSIONLESS_PORT_REVERSE_OWNER,
      adb: createAdbReverseCommands((deps.adbFactory ?? defaultAdbClientFactory).create(device)),
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
    "manage them. Owned mappings lost to an adb or device restart are restored on the next call " +
    "and removed when the session ends. Ports below 1024 are refused. iOS returns not_applicable.",
  input: portReverseInput,
  options: { defaultEnabled: false, outputSchema: portReverseResultSchema },
});

export const portReverseSchema = portReverseTool.schema;

let deviceRemovalSubscribed = false;

function daemonManager(): PortReverseManager {
  if (!deviceRemovalSubscribed) {
    deviceRemovalSubscribed = true;
    subscribePortReverseCleanup(
      { subscribeDeviceRemoval: (l) => getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved(l) },
      defaultPortReverseManager,
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
