/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BootedDevice } from "../../models";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { Logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { IOSCtrlProxyClient } from "../../features/observe/ios/IOSCtrlProxyClient";
import { ObserveElementsBuilder } from "../../features/observe/ObserveElementsBuilder";
import type { IosRunnerEnvironment } from "../../features/observe/ios/iosRunnerFeatureCommands";
import type { CtrlProxyHierarchy } from "../../features/observe/ios/types";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { DoctorProbeOptions } from "../types";
import { awaitDoctorProbe, remainingDoctorProbe } from "../deadline";

/** Per-simulator runner identity gathered by the inspector. */
export interface IosRunnerInspection {
  /** Defaults to simulator: the production inspector only inspects booted simulators. */
  environment?: IosRunnerEnvironment;
  deviceId: string;
  name: string;
  installed: boolean;
  running: boolean;
  /** Advertised command set, or null when the runner could not be reached. */
  supportedCommands: string[] | null;
  /** Advertised non-command feature set, or null for an older/unreachable runner. */
  supportedFeatures: string[] | null;
}

/** Source of booted-simulator runner identities (injectable for tests). */
export interface IosCtrlProxyRunnerInspector {
  inspectBootedRunners(
    targetDeviceId?: string,
    probe?: DoctorProbeOptions,
  ): Promise<IosRunnerInspection[]>;
}

/** Per-simulator result of a real iOS runner observe round trip. */
export interface IosObserveRoundTripInspection {
  deviceId: string;
  name: string;
  runnerPort: number;
  clientPort: number;
  connected: boolean;
  screenSize: { width: number; height: number };
  hierarchyError: string | null;
  elementCount: number;
  /**
   * False when the runner was found not installed or not running, so no request was sent to the
   * simulator at all. Absent means a request was made (#15310).
   */
  probed?: boolean;
}

/** Source of booted-simulator iOS observe round trips (injectable for tests). */
export interface IosObserveRoundTripInspector {
  inspectBootedObserveRoundTrips(
    targetDeviceId?: string,
    probe?: DoctorProbeOptions,
  ): Promise<IosObserveRoundTripInspection[]>;
}

/**
 * Minimal runner-manager surface the inspector needs (install/run probes).
 */
interface IosRunnerManager {
  isInstalled(): Promise<boolean>;
  getServicePort(): number;
  /** Host port that answered a strict device-matched health probe. */
  discoverRunnerPort(probe?: DoctorProbeOptions): Promise<number | null>;
}

/**
 * Minimal runner-client surface the inspector needs: read the advertised command
 * set and (for throwaway probe clients) close the connection afterwards.
 */
interface IosRunnerProbeClient {
  getRunnerIdentityForDiagnostics(
    signal?: AbortSignal,
  ): Promise<{ commands: string[] | null; features: string[] | null } | null>;
  close(): Promise<void>;
}

interface SelectedIosRunnerProbe {
  client: IosRunnerProbeClient;
  closeAfterUse: boolean;
}

function selectIosRunnerProbe(
  existing: IosRunnerProbeClient | null,
  managerReportsRunning: boolean,
  create: () => IosRunnerProbeClient,
): SelectedIosRunnerProbe | null {
  if (existing !== null) {
    return { client: existing, closeAfterUse: false };
  }
  if (managerReportsRunning) {
    return { client: create(), closeAfterUse: true };
  }
  return null;
}

/** Minimal iOS runner client surface for the doctor observe round-trip check. */
interface IosObserveRoundTripClient {
  getConnectionPortForDiagnostics(): number;
  requestHierarchySyncForDiagnostics(
    perf?: unknown,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ hierarchy: CtrlProxyHierarchy } | null>;
  convertToViewHierarchyResult(hierarchy: CtrlProxyHierarchy): ViewHierarchyResult;
  close(): Promise<void>;
}

/**
 * Injection seam for the inspector's device-side singletons, so the
 * close-only-when-created lifecycle is unit-testable without a real device.
 */
export interface IosRunnerInspectorHooks {
  getManager(device: BootedDevice): IosRunnerManager;
  getExistingClient(deviceId: string): IosRunnerProbeClient | null;
  createClient(device: BootedDevice, port: number): IosRunnerProbeClient;
}

/** Injection seam for the iOS observe round-trip inspector. */
export interface IosObserveRoundTripInspectorHooks {
  getManager(device: BootedDevice): IosRunnerManager;
  getExistingClient(deviceId: string): IosObserveRoundTripClient | null;
  createClient(device: BootedDevice, port: number): IosObserveRoundTripClient;
  elementsBuilder: ObserveElementsBuilder;
}

const defaultIosRunnerInspectorHooks: IosRunnerInspectorHooks = {
  getManager: (device) => IOSCtrlProxyManager.getInstance(device),
  getExistingClient: (deviceId) => IOSCtrlProxyClient.getExistingInstance(deviceId),
  // Detached clients delegate diagnostic dials to isolated transient observers.
  createClient: (device, port) => IOSCtrlProxyClient.createDetached(device, { port }),
};

const defaultIosObserveRoundTripInspectorHooks: IosObserveRoundTripInspectorHooks = {
  getManager: (device) => IOSCtrlProxyManager.getInstance(device),
  getExistingClient: (deviceId) => IOSCtrlProxyClient.getExistingInstance(deviceId),
  createClient: (device, port) => IOSCtrlProxyClient.createDetached(device, { port }),
  elementsBuilder: new ObserveElementsBuilder(),
};

/**
 * Real inspector: for each booted simulator, read installed/running from the
 * CtrlProxy manager and the advertised command set from the runner's `connected`
 * handshake. Open resident sockets serve reads directly; closed residents use
 * isolated transient probes regardless of manager running state. Without a
 * resident, probes are created only when the manager reports a running runner.
 * Neither path sets up, starts or restarts a runner.
 */
export function createIosCtrlProxyRunnerInspector(
  createSimctlClient: () => SimCtl,
  log: Logger,
  hooks: IosRunnerInspectorHooks = defaultIosRunnerInspectorHooks,
): IosCtrlProxyRunnerInspector {
  return {
    async inspectBootedRunners(
      targetDeviceId?: string,
      probe: DoctorProbeOptions = {},
    ): Promise<IosRunnerInspection[]> {
      const currentProbe = remainingDoctorProbe(probe);
      const simctl = createSimctlClient();
      if (
        !(await simctl.isAvailable({
          signal: currentProbe.signal,
          timeoutMs: currentProbe.timeoutMs,
        }))
      ) {
        return [];
      }

      const simulators = await simctl.getBootedSimulators(
        currentProbe.timeoutMs,
        currentProbe.signal,
      );
      const inspections: IosRunnerInspection[] = [];
      for (const simulator of simulators.filter(
        (candidate) => targetDeviceId === undefined || candidate.deviceId === targetDeviceId,
      )) {
        currentProbe.signal?.throwIfAborted();
        const device: BootedDevice = {
          name: simulator.name,
          platform: "ios",
          deviceId: simulator.deviceId,
          source: simulator.source,
        };
        const manager = hooks.getManager(device);
        const installed = await manager.isInstalled();
        const runnerPort = installed
          ? await awaitDoctorProbe(currentProbe, () => manager.discoverRunnerPort(currentProbe))
          : null;
        let running = runnerPort !== null;

        let supportedCommands: string[] | null = null;
        let supportedFeatures: string[] | null = null;
        const existing = hooks.getExistingClient(device.deviceId);
        const selectedProbe = selectIosRunnerProbe(existing, running, () =>
          hooks.createClient(device, runnerPort ?? manager.getServicePort()),
        );
        if (selectedProbe === null) {
          inspections.push({
            deviceId: simulator.deviceId,
            name: simulator.name,
            installed,
            running,
            supportedCommands,
            supportedFeatures,
          });
          continue;
        }
        // Don't disturb a client someone else owns (e.g. the daemon's live
        // session): if one already exists, read through it and leave its
        // lifecycle alone. Otherwise open a throwaway probe client and close it
        // afterwards so doctor leaves no persistent runner connection or SDK
        // polling timer behind (especially for the one-shot CLI invocation).
        try {
          const identity = await awaitDoctorProbe(currentProbe, () =>
            selectedProbe.client.getRunnerIdentityForDiagnostics(currentProbe.signal),
          );
          const { commands, features } = identity ?? { commands: null, features: null };
          supportedCommands = commands;
          supportedFeatures = commands === null ? null : features;
          running = running || supportedCommands !== null;
        } catch (error) {
          // Treated as an unreachable runner (versionStatus=unknown), not a hard
          // failure: doctor still reports installed/running for the simulator.
          log.warn(
            `iOS CtrlProxy runner identity probe failed for ${simulator.deviceId}: ${errorMessage(error)}`,
            error,
          );
        } finally {
          if (selectedProbe.closeAfterUse) {
            await selectedProbe.client.close();
          }
        }

        inspections.push({
          deviceId: simulator.deviceId,
          name: simulator.name,
          installed,
          running,
          supportedCommands,
          supportedFeatures,
        });
      }
      return inspections;
    },
  };
}

function iosObserveClientPort(
  existing: IosObserveRoundTripClient | null,
  servicePort: number,
): number {
  return existing?.getConnectionPortForDiagnostics() ?? servicePort;
}

function iosObserveRunnerPort(discoveredRunnerPort: number | null, clientPort: number): number {
  return discoveredRunnerPort ?? clientPort;
}

function iosObserveUnavailableReason(
  installed: boolean,
  discoveredRunnerPort: number | null,
  existing: IosObserveRoundTripClient | null,
): string | null {
  if (!installed) {
    return "iOS CtrlProxy runner is not installed";
  }
  if (discoveredRunnerPort === null && existing === null) {
    return "iOS CtrlProxy runner is not running";
  }
  return null;
}

/**
 * Real iOS observe round-trip inspector: for every booted simulator, verify the
 * runner is installed/running, connect through the same client-side port path
 * `observe` uses, compare that client port to the runner service port, request a
 * fresh hierarchy, and summarize the same non-degenerate signals users see in
 * `observe`.
 */
export function createIosObserveRoundTripInspector(
  createSimctlClient: () => SimCtl,
  log: Logger,
  hooks: IosObserveRoundTripInspectorHooks = defaultIosObserveRoundTripInspectorHooks,
): IosObserveRoundTripInspector {
  return {
    async inspectBootedObserveRoundTrips(
      targetDeviceId?: string,
      probe: DoctorProbeOptions = {},
    ): Promise<IosObserveRoundTripInspection[]> {
      const currentProbe = remainingDoctorProbe(probe);
      const simctl = createSimctlClient();
      if (
        !(await simctl.isAvailable({
          signal: currentProbe.signal,
          timeoutMs: currentProbe.timeoutMs,
        }))
      ) {
        return [];
      }

      const simulators = await simctl.getBootedSimulators(
        currentProbe.timeoutMs,
        currentProbe.signal,
      );
      const inspections: IosObserveRoundTripInspection[] = [];

      for (const simulator of simulators.filter(
        (candidate) => targetDeviceId === undefined || candidate.deviceId === targetDeviceId,
      )) {
        currentProbe.signal?.throwIfAborted();
        const device: BootedDevice = {
          name: simulator.name,
          platform: "ios",
          deviceId: simulator.deviceId,
          source: simulator.source,
        };
        const manager = hooks.getManager(device);
        const servicePort = manager.getServicePort();
        const existing = hooks.getExistingClient(device.deviceId);
        let clientPort = iosObserveClientPort(existing, servicePort);
        const discoveredRunnerPort = await awaitDoctorProbe(currentProbe, () =>
          manager.discoverRunnerPort(currentProbe),
        );
        let runnerPort = iosObserveRunnerPort(discoveredRunnerPort, clientPort);
        let connected = false;
        let screenSize = { width: 0, height: 0 };
        let hierarchyError: string | null = null;
        let elementCount = 0;
        let probed = true;

        const readHierarchy = (
          response: { hierarchy: CtrlProxyHierarchy } | null,
          client: IosObserveRoundTripClient,
        ): void => {
          if (!response?.hierarchy) {
            hierarchyError = "iOS CtrlProxy runner is not running or unreachable";
          } else if (response.hierarchy.error) {
            hierarchyError = response.hierarchy.error;
          } else {
            const viewHierarchy = client.convertToViewHierarchyResult(response.hierarchy);
            hierarchyError = viewHierarchy.hierarchy.error ?? null;
            screenSize = {
              width: viewHierarchy.screenWidth ?? response.hierarchy.screenWidth ?? 0,
              height: viewHierarchy.screenHeight ?? response.hierarchy.screenHeight ?? 0,
            };
            const elements = hooks.elementsBuilder.build(viewHierarchy, "ios");
            elementCount = elements
              ? elements.clickable.length +
                elements.scrollable.length +
                elements.text.length +
                elements.media.length
              : 0;
          }
        };

        const inspection = (): IosObserveRoundTripInspection => ({
          deviceId: simulator.deviceId,
          name: simulator.name,
          runnerPort,
          clientPort,
          connected,
          screenSize,
          hierarchyError,
          elementCount,
          ...(probed ? {} : { probed }),
        });
        try {
          const installed = await manager.isInstalled();
          hierarchyError = iosObserveUnavailableReason(installed, discoveredRunnerPort, existing);
          probed = hierarchyError === null;
        } catch (error) {
          hierarchyError = errorMessage(error);
          log.warn(
            `iOS observe round-trip failed for ${simulator.deviceId}: ${hierarchyError}`,
            error,
          );
        }

        if (hierarchyError !== null) {
          inspections.push(inspection());
          continue;
        }

        try {
          const client = existing ?? hooks.createClient(device, runnerPort);
          try {
            clientPort = client.getConnectionPortForDiagnostics();
            const response = await client.requestHierarchySyncForDiagnostics(
              undefined,
              false,
              currentProbe.signal,
              currentProbe.timeoutMs,
            );
            currentProbe.signal?.throwIfAborted();
            clientPort = client.getConnectionPortForDiagnostics();
            runnerPort = iosObserveRunnerPort(discoveredRunnerPort, clientPort);
            connected = response !== null;
            readHierarchy(response, client);
          } finally {
            existing === null && (await client.close());
          }
        } catch (error) {
          hierarchyError = errorMessage(error);
          log.warn(
            `iOS observe round-trip failed for ${simulator.deviceId}: ${hierarchyError}`,
            error,
          );
        }

        inspections.push(inspection());
      }

      return inspections;
    },
  };
}
