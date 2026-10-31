import type { DeleteDeviceOptions } from "../../features/deviceLifecycle/teardown/teardownContracts";
import type { DeviceResourceConfigurationResult } from "../../models/DeviceResourceConfiguration";
import { BootedDevice, DeviceInfo } from "../../models";
import { createPerformanceTracker } from "../../utils/PerformanceTracker";
import { type AcquisitionReceipt } from "../../daemon/acquisitionReceipt";
import type { DeviceReadinessLevel } from "../../daemon/readiness/DeviceReadiness";
import type { DeviceReadinessReservation } from "../../daemon/devicePool";
import { type DeviceCreationGate } from "../../devices/deviceCreationGate";
import { type ExactDeviceProvisioner } from "../../devices/exactDeviceProvisioning";
import { type VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";
import { DeviceTeardownService } from "../../devices/deviceTeardownService";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import type { RunnerReadinessRequest } from "../../ctrlProxy/RunnerReadinessService";
import {
  DeviceToolsDependencies,
  StartDeviceArgs,
  TeardownDeviceArgs,
  TeardownToolResponse,
  createProvisionDeviceResponse,
  createToolErrorResponse,
} from "../../features/deviceLifecycle/deviceLifecycleCore";

export type ProvisioningHooks = {
  bindBootedDeviceSession: (
    device: BootedDevice,
    args: StartDeviceArgs,
    sourceImage: DeviceInfo | undefined,
    options: {
      childProcess?: ChildProcess | null;
      autolockEnabled?: boolean;
      readinessReservationOwners?: ReadonlySet<symbol>;
      verifiedAndroidAvdIdentity?: DeviceInfo;
      achievedReadiness?: DeviceReadinessLevel;
      collectCancellationSettlement?: (settlement: Promise<void>) => void;
      receipt?: AcquisitionReceipt;
      signal: AbortSignal | undefined;
    },
  ) => Promise<string>;
  ensureCtrlProxyReady: (request: RunnerReadinessRequest) => Promise<void>;
  executeDeleteDevice: (
    args: TeardownDeviceArgs,
    deps: DeviceToolsDependencies,
    callerSignal: AbortSignal | undefined,
    options: DeleteDeviceOptions & { teardownService: DeviceTeardownService },
  ) => Promise<TeardownToolResponse>;
};

/** The shared dependencies every provisioning module receives. */
export type ProvisioningContext = ProvisioningHooks;

/** The exact identity an iOS simulator is matched by: UDID, else name + runtime + device type. */
export type ExactIosDeviceIdentity = {
  name: string;
  deviceId?: string;
  runtime?: string;
  deviceType?: string;
};

/** Where a failed provision's rollback should aim; `unresolved` never means absent. */
export type ProvisionRollbackTarget =
  | { kind: "device"; device: DeviceInfo }
  | { kind: "absent" }
  | { kind: "unresolved" };

/** The response a cancelled provisionDevice request already built, so it is built only once. */
export type ProvisionCancellation = { response?: ProvisionDeviceToolResponse };

export type ProvisionDeviceToolResponse =
  | ReturnType<typeof createProvisionDeviceResponse>
  | ReturnType<typeof createToolErrorResponse>;

export type ProvisionBootOptions = {
  /** Deletes the device this request created, for a request undone after it bound (#11593). */
  deleteCreatedIfUndelivered?: (
    lifecycleLease: VirtualDeviceLifecycleLease,
    reason: unknown,
  ) => Promise<void>;
  /** Records that an adopted device's undone request left nothing of its own behind. */
  recordUndeliveredAdoption?: (reason: unknown) => void;
  deviceCreationGate: DeviceCreationGate;
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>;
  perf: ReturnType<typeof createPerformanceTracker>;
  totalDeadlineMs: number;
  lifecycleLease: VirtualDeviceLifecycleLease;
  signal: AbortSignal | undefined;
  settlementState: ProvisionSettlementState;
  onBooted: (device: BootedDevice) => void;
};

export type ProvisionSettlementState = {
  /** Conservative launch boundary: even a rejected boot call may have launched the AVD. */
  bootAttempted?: boolean;
  /** Only a retryable readiness deadline after creation, before binding, may retain a simulator. */
  retainCreatedForRetry?: boolean;
  exactProvisioning?: Promise<unknown>;
  unownedColdBootSettlement?: Promise<void>;
  bindingSettlements: Promise<unknown>[];
  readinessReservation?: DeviceReadinessReservation;
};

export type ProvisionBootResult = {
  device: BootedDevice;
  sessionId: string;
  source: "booted" | "cold-boot";
  sourceImage?: DeviceInfo;
  resources?: DeviceResourceConfigurationResult;
  /** The applied `deviceProfile` (#14058), in the manufacturerProfile tool's result shape. */
  manufacturerProfile?: Record<string, unknown>;
};
