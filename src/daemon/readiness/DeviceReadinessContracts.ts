import type { BootedDeviceDiscoveryOptions } from "../../devices/deviceDiscoveryContracts";
import type { CtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { CtrlProxyIosManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { type IosSimulatorCreator } from "../../devices/deviceProvisioning";
import { type DeviceManagerSimCtl } from "../../devices/deviceUtils";
import { type VirtualDeviceLifecycleCoordinator } from "../../devices/virtualDeviceLifecycleCoordinator";
import type { IosBootInstrumentation } from "../../features/iosSimFleet/IosBootInstrumentation";
import { RealObserveScreen } from "../../features/observe/ObserveScreen";
import { Window as WindowImpl } from "../../features/observe/Window";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import type { AndroidCtrlProxy } from "../../features/observe/android/AndroidCtrlProxyClient";
import type { Window } from "../../features/observe/interfaces/Window";
import { IOSCtrlProxyClient } from "../../features/observe/ios";
import type { IosCtrlProxy } from "../../features/observe/ios/IOSCtrlProxyClient";
import { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../models";
import type { ObserveScreenCache } from "../../models/ObserveScreenCache";
import { type IdGenerator } from "../../utils/IdGenerator";
import { type Timer } from "../../utils/SystemTimer";
import { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DeviceAdmissionGate } from "../../utils/deviceAdmissionGate";
import { type DeviceExecutionBinding } from "../../utils/deviceExecutionBinding";
import { type DiscoverySource } from "../../utils/discoverySource";
import { PlatformDeviceManager } from "../../utils/interfaces/DeviceUtils";
import type { IosPhysicalDeviceLister } from "../../utils/ios-cmdline-tools/DevicectlDeviceLister";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { type AppearanceOnConnectDependencies } from "../applyAppearanceOnConnect";
import type { BindingExclusion } from "../sessionBroker/provisioning/exclusion";
import {
  DefaultDeviceClientProvider,
  type ObserveClientFactories,
} from "./DefaultDeviceClientProvider";

/**
 * The simctl surface the session manager drives, plus what the device manager built from it
 * needs. Exactly what consumers use, so a fake (`FakeSimctl`) satisfies it without a cast.
 */
export type DeviceClientSimctl = DeviceManagerSimCtl &
  IosSimulatorCreator &
  Pick<SimCtl, "bootSimulator" | "getDeviceInfo" | "presentSimulatorAfterStart">;

/**
 * Provider interface for device clients - enables dependency injection for testing
 */
export interface DeviceClientProvider {
  getAdb(): AdbExecutor;
  getSimctl(): DeviceClientSimctl | undefined;
  getAndroidEmulator(): AndroidEmulatorClient | undefined;
  getDeviceUtils(): PlatformDeviceManager;
  /**
   * Connected physical iOS device discovery for readiness scans (#11063).
   * Optional: a provider without one leaves the `ios-physical` source unscanned.
   */
  getIosPhysicalDeviceLister?(): IosPhysicalDeviceLister | undefined;
  getAndroidCtrlProxyManager(device: BootedDevice): CtrlProxyManager;
  getAndroidCtrlProxyClient(device: BootedDevice): AndroidCtrlProxy;
  getIOSCtrlProxyManager(device: BootedDevice): CtrlProxyIosManager;
  getIOSCtrlProxyClient(device: BootedDevice, port: number): IosCtrlProxy;
  getWindow(device: BootedDevice): Window;
  getObserveScreenCache(): ObserveScreenCache;
}

/** Observe-layer clients wired at the composition root, so the provider imports none of them. */
export const defaultObserveClientFactories: ObserveClientFactories = {
  androidCtrlProxyClient: (device) => AndroidCtrlProxyClient.getInstance(device),
  iosCtrlProxyClient: (device, port) => IOSCtrlProxyClient.getInstance(device, port),
  createWindow: (device, adbFactory) => new WindowImpl(device, adbFactory),
  observeScreenCache: () => RealObserveScreen.defaultObserveScreenCache,
};

/** The production provider, with the observe-layer clients injected. */
export function createDefaultDeviceClientProvider(
  adbFactory?: AdbClientFactory,
): DefaultDeviceClientProvider {
  return new DefaultDeviceClientProvider(defaultObserveClientFactories, adbFactory);
}

/**
 * Interface for device session management
 * Handles device detection, verification, and lifecycle for Android and iOS platforms
 */
export interface DeviceReadinessContract {
  /** Explicit selection made by this connection's legacy setActiveDevice tool. */
  getExplicitDevicePin(connectionId?: string): BootedDevice | undefined;
  setExplicitDevicePin(device: BootedDevice, connectionId?: string): void;
  /** Invalidate every connection's pin naming a released or removed device. */
  clearExplicitDevicePin(deviceId: string): void;
  /** Forget only the disconnected connection's selection. */
  clearConnectionDevicePin(connectionId: string): void;

  /**
   * Ensure a device is ready for the specified platform and return its ID
   * Throws an error if both Android and iOS devices are connected when auto-detecting platform
   */
  ensureDeviceReady(
    platform: SomePlatform,
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice>;

  /**
   * Detect the platform of connected devices
   */
  detectConnectedPlatforms(signal?: AbortSignal): Promise<BootedDevice[]>;
  detectConnectedPlatformsWithStatus(
    signal?: AbortSignal,
    options?: ConnectedPlatformScanOptions,
  ): Promise<ConnectedPlatformScan>;

  /**
   * Verify a specific device is connected and ready for the given platform.
   * `resolvedIdentity` carries the AVD-resolved discovery entry for an Android
   * emulator so readiness caches key on the runtime, not the reused serial.
   */
  verifyDevice(
    deviceId: string,
    platform: Platform,
    options?: DeviceReadyOptions,
    resolvedIdentity?: ResolvedDeviceIdentity,
  ): Promise<void>;

  /**
   * Verify an Android device is connected and ready
   */
  verifyAndroidDevice(deviceId: string, options?: DeviceReadyOptions): Promise<void>;

  /** Fresh, complete Android inventory for session-broker reset verification. */
  listBootedAndroidDevices(
    options?: Pick<
      BootedDeviceDiscoveryOptions,
      "signal" | "androidTargetDeviceId" | "skipAndroidProfileEnrichment"
    >,
  ): Promise<BootedDevice[]>;

  /** Verify CtrlProxy health through the injected device-client provider. */
  verifyAndroidCtrlProxyServiceReady(
    device: BootedDevice,
    options?: { signal?: AbortSignal; timeoutMs?: number; noRetry?: boolean },
  ): Promise<boolean>;
  readAndroidCtrlProxySnapshotIdentity(device: BootedDevice, signal: AbortSignal): Promise<string>;

  /**
   * Verify an iOS device is connected and ready
   */
  verifyIosDevice(deviceId: string, options?: DeviceReadyOptions): Promise<void>;

  /**
   * Find an available device or start an emulator for the specified platform
   */
  findOrStartDevice(platform: Platform, options?: DeviceReadyOptions): Promise<BootedDevice>;

  /**
   * Find an available Android device or start an emulator
   */
  findOrStartAndroidDevice(options?: DeviceReadyOptions): Promise<BootedDevice>;

  /**
   * Find an available iOS device or start a simulator
   */
  findOrStartIosDevice(options?: DeviceReadyOptions): Promise<BootedDevice>;
}

export interface ConnectedPlatformScan {
  devices: BootedDevice[];
  /** A platform is scanned when at least one of its discovery sources completed. */
  scanned: Record<Platform, boolean>;
  /**
   * Per-source completeness (#11063). iOS has two independent sources, so a
   * pinned device's absence is authoritative only when its own source
   * completed. Absent for producers that report platforms only.
   */
  scannedSources?: Partial<Record<DiscoverySource, boolean>>;
}

export type DeviceReadinessLevel = "booted" | "automationReady";

/** Same cadence as the deleteDevice absence verification (DEVICE_SHUTDOWN_POLL_INTERVAL_MS). */
export const CREATED_IOS_ABSENCE_POLL_MS = 1_000;

export const CREATED_IOS_ABSENCE_TIMEOUT_MS = 10_000;

/**
 * Ordering of {@link DeviceReadinessLevel} by how much setup each represents
 * having achieved. `SessionManager.setDeviceReadiness` (#6227 round 7) uses
 * this to keep the recorded level monotonic — a session's readiness record
 * may only be raised, never silently downgraded by a later, less-demanding
 * acquisition of the same session.
 */
export const DEVICE_READINESS_RANK: Readonly<Record<DeviceReadinessLevel, number>> = {
  booted: 0,
  automationReady: 1,
};

export function deviceReadinessRank(level: DeviceReadinessLevel): number {
  return DEVICE_READINESS_RANK[level];
}

/** The discovery entry that resolved an Android runtime's identity for a serial. */
export type ResolvedDeviceIdentity = Pick<BootedDevice, "deviceId" | "name" | "observedAt">;

export interface DeviceReadyOptions {
  sessionId?: string;
  /** MCP connection key for explicit selection; omitted for the single direct stdio connection. */
  connectionId?: string;
  /**
   * What the caller will do with the device. A `read` gets only the readiness reading needs: no
   * current-device pin or appearance write (#11641). Defaults to `control`.
   * A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
   * (owner decision 2026-10-12, #11964). Android readiness may write CtrlProxy accessibility settings.
   * A read may boot only the `deviceId` supplied on this call, after alias resolution.
   * Platform-only selection, a setActiveDevice pin, and a cached current device are not
   * explicit IDs. Session-bound calls keep control readiness (toolRegistry does not mark them read).
   */
  intent?: "read" | "control";
  /** Last read ownership check after image discovery, before any lifecycle or boot work. */
  beforeReadBoot?: (image: DeviceInfo) => Promise<void>;
  /** Resolved read identity check before runner resume or verification. */
  beforeReadReadiness?: (device: BootedDevice) => Promise<void>;
  skipCtrlProxyDownload?: boolean;
  signal?: AbortSignal;
  /** Reuses device discovery already started by the current target resolution. */
  getConnectedPlatforms?: () => Promise<ConnectedPlatformScan | BootedDevice[]>;
  /**
   * `booted` verifies only that the target is connected and booted.
   * `automationReady` additionally prepares CtrlProxy. Defaults to
   * `automationReady` for existing device-aware tools.
   */
  readiness?: DeviceReadinessLevel;
  /**
   * @deprecated Use skipCtrlProxyDownload instead.
   */
  skipAccessibilityDownload?: boolean;
  /**
   * @deprecated Use skipCtrlProxyDownload instead.
   */
  skipAccessibilitySetup?: boolean;
}

export interface ConnectedPlatformScanOptions {
  /** An Android-only caller never waits on (or scans) the physical iOS lister (#11077). */
  platform?: SomePlatform;
}

export interface DeviceReadinessOptions {
  /** Refreshed only for implicit boots; defaults to the host-wide binding registry. */
  bindingExclusion?: Pick<BindingExclusion, "refresh" | "holderOf">;
  /** Overrides {@link PHYSICAL_IOS_SCAN_BUDGET_MS}. */
  physicalIosScanBudgetMs?: number;
  appearanceOnConnectDependencies?: Partial<AppearanceOnConnectDependencies>;
  admissionGate?: DeviceAdmissionGate;
  executionBinding?: DeviceExecutionBinding;
  runnerReadinessTimer?: Timer;
  runnerReadinessTimeoutMs?: number;
  /**
   * Boot-class budget for one-time runner provisioning (cold CtrlProxy launch)
   * on the session auto-start path, which owns no separate device-boot deadline.
   * Defaults to {@link DEFAULT_RUNNER_PROVISION_TIMEOUT_MS} (#5376).
   */
  runnerProvisionTimeoutMs?: number;
  lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator;
  idGenerator?: IdGenerator;
  /**
   * Capacity gating and boot-duration recording for simulator boots this manager starts itself
   * (`findOrStartIosDevice`). Defaults to the process-wide iOS gate (#11236).
   */
  iosBootInstrumentation?: IosBootInstrumentation;
}
