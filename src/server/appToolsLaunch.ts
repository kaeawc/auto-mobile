import { LaunchApp, type LaunchAppCall } from "../features/action/LaunchApp";
import {
  getLaunchObservationPackageNames,
  isLaunchPermissionDialogObservation,
} from "../features/action/launchObservationPackages";
import { resolveMissingForegroundWindow } from "../features/observe/ObserveScreen";
import { NodePrototypeAgentConnector } from "../features/prototype/ios/prototypeAgentClient";
import {
  createPrototypeAgentConnect,
  portManagerPrototypeAgentPorts,
  PrototypeAgentInjector,
  prototypeAgentRegistry,
  type PreparedPrototypeLaunch,
  type PrototypeAgentRecord,
  type PrototypeAgentRegistry,
} from "../features/prototype/ios/prototypeAgentInjection";
import { PrototypeAgentProvider } from "../features/prototype/ios/PrototypeAgentProvider";
import {
  createPrototypeViewerAttacher,
  prototypeViewerConnections,
  type PrototypeViewerConnections,
  type PrototypeViewerLaunchAttacher,
} from "../features/prototype/ios/prototypeViewerAttach";
import { iosMutationTokens } from "../features/storage/IosMutationTokens";
import { ActionableError, BootedDevice, type LaunchAppResult } from "../models";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { LaunchAppActionArgs } from "./appToolsSchemas";

export interface LaunchAppExecutor {
  execute(appId: string, launch: LaunchAppCall): Promise<LaunchAppResult>;
}

/** Injects the iOS simulator prototype agent around a launch (#10567). */
export interface PrototypeAgentLaunchInjector {
  prepare(device: BootedDevice, bundleId: string): Promise<PreparedPrototypeLaunch>;
  attach(prepared: PreparedPrototypeLaunch, pid?: number): Promise<PrototypeAgentRecord>;
  abort(prepared: PreparedPrototypeLaunch): void;
}

// Injection seam for the launchApp handler (mirrors the terminateApp/crashApp
// dependency seams in this file). Lets a unit test exercise the REGISTERED
// handler wiring with a fake LaunchApp, so the already-foreground response shape
// is covered by a test rather than only the response builder (issue #6868).
export interface LaunchAppToolDependencies {
  createLaunchApp(device: BootedDevice): LaunchAppExecutor;
  idGenerator: IdGenerator;
  /** Agent records shared by launchApp, terminateApp and the prototype tool. */
  prototypeAgentRegistry: PrototypeAgentRegistry;
  prototypeViewerAttacher: PrototypeViewerLaunchAttacher;
  prototypeViewerConnections: Pick<PrototypeViewerConnections, "release" | "releaseDevice">;
  timer: Timer;
  /** Created on first `prototype: true`, so a normal launch never resolves the agent dylib. */
  createPrototypeAgentInjector(registry: PrototypeAgentRegistry): PrototypeAgentLaunchInjector;
}

function createDefaultPrototypeAgentInjector(
  registry: PrototypeAgentRegistry,
): PrototypeAgentInjector {
  return new PrototypeAgentInjector({
    dylibResolver: PrototypeAgentProvider.getInstance(),
    ports: portManagerPrototypeAgentPorts,
    registry,
    connect: createPrototypeAgentConnect(new NodePrototypeAgentConnector(), defaultTimer),
    idGenerator: defaultIdGenerator,
    hostEnv: process.env,
  });
}

export function createDefaultLaunchAppToolDependencies(): LaunchAppToolDependencies {
  let viewerAttacher: ReturnType<typeof createPrototypeViewerAttacher> | undefined;
  return {
    createLaunchApp: (device) => new LaunchApp(device),
    idGenerator: defaultIdGenerator,
    prototypeAgentRegistry,
    prototypeViewerConnections,
    timer: defaultTimer,
    prototypeViewerAttacher: {
      attach: (device, bundleId) => {
        viewerAttacher ??= createPrototypeViewerAttacher();
        return viewerAttacher.attach(device, bundleId);
      },
    },
    createPrototypeAgentInjector: createDefaultPrototypeAgentInjector,
  };
}

/** Report the first identity signal from the shared launch observation resolver. */
function isVerifiedLaunchObservation(
  appId: string,
  observation: LaunchAppResult["observation"],
): boolean {
  const packageNames = getLaunchObservationPackageNames(observation);
  return (
    packageNames.length > 0 &&
    packageNames.every((packageName) => packageName === appId) &&
    observation?.freshness?.isFresh !== false &&
    observation?.freshness?.verified !== false
  );
}

/**
 * Reason a launch could not be verified (issue #6220), for the case where no
 * foreground application window was observed at all, or foreground identity
 * signals conflict with each other or the requested app.
 */
type LaunchVerificationFailureReason =
  | "no_observation"
  | "no_foreground_window"
  | `foreground signals disagree: activeWindow=${string}, hierarchy=${string}`
  | `foreground package ${string} does not match requested ${string}`;

function launchVerificationFailureReason(
  appId: string,
  observedAppId: string | undefined,
  observation: LaunchAppResult["observation"],
): LaunchVerificationFailureReason | undefined {
  if (isLaunchPermissionDialogObservation(observation)) {
    return undefined;
  }
  if (observation === undefined) {
    return "no_observation";
  }
  // `resolveMissingForegroundWindow` (the SAME machine-readable verdict the
  // observe freshness gate uses) is consulted here too, not just an empty
  // `observedAppId` (issue #6239 review follow-up): a status-bar-only capture
  // can still carry STALE `activeWindow.appId`/`packageName` metadata from a
  // previously-resumed app, which would otherwise make `observedAppId` look
  // like a real (if wrong) observed app and suppress this structured failure.
  if (!observedAppId || resolveMissingForegroundWindow(observation) !== undefined) {
    return "no_foreground_window";
  }
  const activeWindowPackage = observation.activeWindow?.appId;
  const hierarchyPackage = observation.viewHierarchy?.packageName;
  if (activeWindowPackage && hierarchyPackage && activeWindowPackage !== hierarchyPackage) {
    return `foreground signals disagree: activeWindow=${activeWindowPackage}, hierarchy=${hierarchyPackage}`;
  }
  if (observedAppId !== appId) {
    return `foreground package ${observedAppId} does not match requested ${appId}`;
  }
  return undefined;
}

function launchVerificationFailureMessage(reason: LaunchVerificationFailureReason): string {
  if (reason === "no_observation") {
    return "no observation was captured after launch";
  }
  if (reason === "no_foreground_window") {
    return "no foreground application window could be observed after launch";
  }
  return reason;
}

function buildLaunchMessage(
  appId: string,
  verified: boolean | undefined,
  verifyFailureReason: LaunchVerificationFailureReason | undefined,
  alreadyForeground: boolean | undefined,
): string {
  // An app that was already foreground was never launched — say so rather than
  // claiming a launch that did not happen (issue #6868). The verification suffix
  // is unchanged: it describes the observed end state either way.
  const lead = alreadyForeground
    ? `App ${appId} was already in the foreground`
    : `Launched app ${appId}`;
  if (verified === true) {
    return `${lead} (foreground verified)`;
  }
  if (verifyFailureReason) {
    return `${lead} (verification failed: ${launchVerificationFailureMessage(verifyFailureReason)})`;
  }
  return lead;
}

/**
 * Build the launchApp tool response from a {@link LaunchAppResult}, enforcing the
 * launch postcondition instead of reporting a flat "Launched app X" success
 * regardless of what actually happened (#5868).
 *
 * `LaunchApp.execute` already resolves the package (returning `success:false`
 * with "App is not installed" for an uninstalled package) and reconciles the
 * launch observation against the requested app (returning `success:false` when
 * the foreground app never matches). This surfaces those typed failures as a
 * real error — mirroring the terminate handler (#5621) — rather than swallowing
 * them behind a success message. On success it additionally reports the observed
 * foreground appId and whether it matched, so a client can skip a confirming
 * `observe` round-trip.
 *
 */
/** Report the first reconciled package; verification requires every signal to agree. */
function resolveLaunchObservedAppId(
  observation: LaunchAppResult["observation"],
): string | undefined {
  return getLaunchObservationPackageNames(observation)[0];
}

/**
 * Build the launchApp response from a successful launch result. `verified` is
 * `true` when every reconciled foreground package matches the requested app in
 * a fresh, verified observation. It is `false` with a reason when no foreground
 * window is available, foreground identity signals disagree, or the observed
 * package differs from the requested app. It remains `undefined` for an
 * accepted notification permission surface or matching-but-stale observation,
 * where the surface or freshness prevents confirmation.
 */
export function buildLaunchAppResponse(appId: string, result: LaunchAppResult) {
  if (!result.success) {
    // `||` not `??`: an empty-string error must still yield the non-empty
    // fallback rather than surfacing a blank message.
    throw new ActionableError(result.error || `Failed to launch app ${appId}`);
  }

  const observedAppId = resolveLaunchObservedAppId(result.observation);
  // Only assert verification on an exact foreground match with a fresh, verified
  // observation. `LaunchApp.execute` retries an unverified observation, but this
  // response-level guard preserves the true-or-undefined contract for any direct
  // caller that supplies one. Identity conflicts and mismatches are then
  // surfaced as a structured verification failure below.
  const isVerified = isVerifiedLaunchObservation(appId, result.observation);
  const verifyFailureReason = isVerified
    ? undefined
    : launchVerificationFailureReason(appId, observedAppId, result.observation);
  const verified = isVerified ? true : verifyFailureReason ? false : undefined;

  return {
    message: buildLaunchMessage(appId, verified, verifyFailureReason, result.alreadyForeground),
    verified,
    ...(verifyFailureReason ? { verifyFailureReason } : {}),
    observedAppId,
    observation: result.observation,
    ...result,
  };
}

export function prepareLaunchArguments(
  device: BootedDevice,
  args: LaunchAppActionArgs,
  idGenerator: IdGenerator,
): { launchArguments?: string[]; mutationToken?: string } {
  if (args.launchArguments?.includes("--automobile-mutation-token")) {
    throw new ActionableError("launchArguments contains a reserved argument");
  }
  if (device.platform !== "ios") {
    return { launchArguments: args.launchArguments };
  }

  iosMutationTokens.clear(device.deviceId, args.appId);
  if (!args.launchArguments?.includes("--allow-storage-mutations")) {
    return { launchArguments: args.launchArguments };
  }
  const mutationToken = idGenerator.next();
  iosMutationTokens.set(device.deviceId, args.appId, mutationToken);
  return {
    launchArguments: [...args.launchArguments, "--automobile-mutation-token", mutationToken],
    mutationToken,
  };
}

export function executeLaunch(
  launchApp: LaunchAppExecutor,
  args: LaunchAppActionArgs,
  launchArguments: string[] | undefined,
  { prototypeLaunch, signal }: { prototypeLaunch?: PrototypeLaunch; signal?: AbortSignal } = {},
): Promise<LaunchAppResult> {
  return launchApp.execute(args.appId, {
    clearAppData: args.clearAppData ?? false,
    // Injection takes effect only in a fresh process.
    coldBoot: (args.coldBoot ?? false) || prototypeLaunch !== undefined,
    signal,
    launchArguments,
    launchEnvironment: prototypeLaunch?.environment,
    intent: args.intent,
  });
}

export async function attachLaunchedViewer(
  attacher: LaunchAppToolDependencies["prototypeViewerAttacher"],
  timer: Timer,
  device: BootedDevice,
  args: Pick<LaunchAppActionArgs, "appId" | "prototype">,
): Promise<void> {
  if (args.prototype || device.platform !== "ios" || resolveIosDeviceKind(device) !== "simulator") {
    return;
  }
  let timedOut = false;
  try {
    await raceWithDeadline(() => attacher.attach(device, args.appId), {
      timer,
      timeoutMs: 3000,
      label: "Optional prototype viewer attach",
      onTimeout: () => {
        timedOut = true;
        logger.debug("[AppTools] Optional prototype viewer attach timed out.");
      },
    });
  } catch {
    // Expected for every app that is not a viewer; safe to swallow because launch already succeeded.
    if (!timedOut) {
      logger.debug("[AppTools] Optional prototype viewer attach was unavailable.");
    }
  }
}

/** The agent fields a client may see; the auth token stays in the daemon. */
function describePrototypeAgent(agent: PrototypeAgentRecord) {
  return {
    port: agent.port,
    agentVersion: agent.handshake.agentVersion,
    protocolVersion: agent.handshake.protocolVersion,
    capabilities: agent.handshake.capabilities,
  };
}

/** A `prototype: true` launch in progress: its env, then attach on success or abort on failure. */
export interface PrototypeLaunch {
  environment: Record<string, string>;
  attach<T extends { message: string }>(
    response: T,
    pid?: number,
  ): Promise<T & { prototypeAgent: ReturnType<typeof describePrototypeAgent> }>;
  /** Frees the port unless the agent attached; safe to call more than once. */
  abort(): void;
}

export async function beginPrototypeLaunch(
  dependencies: LaunchAppToolDependencies,
  device: BootedDevice,
  appId: string,
): Promise<PrototypeLaunch> {
  const injector = dependencies.createPrototypeAgentInjector(dependencies.prototypeAgentRegistry);
  const prepared = await injector.prepare(device, appId);
  let settled = false;
  return {
    environment: prepared.environment,
    async attach(response, pid) {
      const agent = await injector.attach(prepared, pid);
      settled = true;
      return {
        ...response,
        message: `${response.message}; prototype agent ${agent.handshake.agentVersion} connected`,
        prototypeAgent: describePrototypeAgent(agent),
      };
    },
    abort() {
      if (!settled) {
        settled = true;
        injector.abort(prepared);
      }
    },
  };
}
