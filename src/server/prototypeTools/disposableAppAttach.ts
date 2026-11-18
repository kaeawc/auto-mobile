import { logger } from "../../utils/logger";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { PrototypeAgentClient } from "../../features/prototype/ios/prototypeAgentClient";
import type { PrototypeTarget, PrototypeOutput } from "./types";
import type { BootedDevice } from "../../models";
import { AndroidDisposableAppAttacher } from "../../features/prototype/disposableApp/android/AndroidDisposableAppAttacher";
import { FileDisposableAppRegistry } from "../../features/prototype/disposableApp/DisposableAppRegistry";
import { NodeDisposableAppRegistryStore } from "../../features/prototype/disposableApp/NodeDisposableAppRegistryStore";
import type { PrototypeToolDependencies } from "./types";

class AmbiguousDisposableAppError extends ActionableError {}

export function isDisposableAppAttachAction(
  device: BootedDevice,
  args: { action: string; id?: string },
): boolean {
  return (
    device.platform === "android" &&
    !!args.id &&
    ["patch", "status", "inspect", "awaitEvent"].includes(args.action)
  );
}

/** Registry-only routing probe; construct the socket attacher only after a match. */
export function lazyDisposableAppAttach(deps: PrototypeToolDependencies) {
  let registry = deps.disposableAppRegistry;
  let attacher = deps.disposableAppAttacher;
  return (device: BootedDevice, args: { action: string; id?: string }) => {
    if (!isDisposableAppAttachAction(device, args)) {
      return undefined;
    }
    if (!registry) {
      const store = new NodeDisposableAppRegistryStore();
      if (!store.exists()) {
        return undefined;
      }
      registry = new FileDisposableAppRegistry(store);
    }
    return attachMatch(device, args, registry);
  };

  async function attachMatch(
    device: BootedDevice,
    args: { id?: string },
    registry: NonNullable<PrototypeToolDependencies["disposableAppRegistry"]>,
  ) {
    const matches = (await registry.list(device.deviceId)).filter(
      (record) => record.platform === "android" && record.specId === args.id,
    );
    if (matches.length > 1) {
      throw new AmbiguousDisposableAppError(
        `Prototype id "${args.id}" matches disposable app slugs: ${matches
          .map((app) => app.slug)
          .sort()
          .join(", ")}. Use distinct spec ids or uninstall the conflicting apps.`,
      );
    }
    const match = matches[0];
    if (!match) {
      return undefined;
    }
    attacher ??= new AndroidDisposableAppAttacher({
      registry,
      adbFactory: deps.adbFactory,
      timer: deps.timer,
    });
    return attacher.attach(device, match.appId);
  }
}

/** Preserve attach guidance unless CtrlProxy confirms that it is showing this id. */
export async function disposableAppTarget(
  device: BootedDevice,
  pending: Promise<PrototypeAgentClient | undefined>,
  routes: {
    target(device: BootedDevice, agent: PrototypeAgentClient): PrototypeTarget;
    fallback(): Promise<PrototypeTarget | undefined>;
  },
): Promise<PrototypeTarget | PrototypeOutput | undefined> {
  try {
    const agent = await pending;
    return agent ? { ...routes.target(device, agent), disposableApp: true } : undefined;
  } catch (error) {
    logger.warn("Disposable prototype app attachment failed.");
    let fallback: PrototypeTarget | undefined;
    if (!(error instanceof AmbiguousDisposableAppError)) {
      try {
        fallback = await routes.fallback();
      } catch {
        // An optional CtrlProxy probe can fail when the app owns the foreground; keep attach guidance.
        logger.debug("CtrlProxy fallback probe unavailable after disposable app attach failure.");
      }
    }
    if (fallback) {
      return fallback;
    }
    return {
      success: false,
      error: toActionableError(error, "Could not attach disposable prototype app").message,
    };
  }
}
