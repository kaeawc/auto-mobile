import type {
  AndroidDeviceSpecification,
  IosDeviceSpecification,
} from "../../../devices/exactDeviceProvisioning";
import { MIN_CONFIGURED_SESSION_IDLE_TIMEOUT_MS } from "../../wire/sessionLivenessWindows";
import type {
  BindingDeviceFamily,
  WatchBindingSpec,
} from "../../../utils/provisionDeviceSpecSchemas";
import { ActionableError } from "../../../models/ActionableError";
export type BrokerDeviceRequest = {
  bindingIndex: number;
  role: string;
  priorDeviceHint?: { stableId: string };
} & (
  | {
      platform: "android";
      requestedSpec: Omit<AndroidDeviceSpecification, "deviceType"> & {
        deviceType?: string;
        deviceFamily?: BindingDeviceFamily;
      };
    }
  | {
      platform: "ios";
      requestedSpec: Omit<IosDeviceSpecification, "deviceType"> & {
        deviceType?: string;
        deviceFamily?: BindingDeviceFamily;
      };
    }
  /** One unpaired Apple Watch simulator, by exact runtime and device type (#15882). */
  | { platform: "watchos"; requestedSpec: WatchBindingSpec }
);
/** Internal provisioning request, built directly by the broker without launch contract parsing. */
export interface BrokerProvisionRequest {
  contractVersion: 1;
  managedHostScope: string;
  runnerNamespace: string;
  runnerIncarnation: string;
  executionAttempt?: string;
  localBindingCapacity: number;
  requests: BrokerDeviceRequest[];
  preparationTimeoutMs?: number;
  /**
   * Milliseconds an empty binding's create path holds back from `preparationTimeoutMs` so the
   * caller keeps one warm readiness retry window. Adoption and reuse keep the full deadline.
   */
  createRetryReserveMs?: number;
  idleTimeoutMs?: number;
  executionOwnerPid?: number;
  executionOwnerStartIdentity?: string;
}
export const MIN_BINDING_IDLE_TIMEOUT_MS = MIN_CONFIGURED_SESSION_IDLE_TIMEOUT_MS;
export const MAX_BINDING_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export type BindingConfigErrorCode = "binding_config_invalid";
export class BindingConfigError extends ActionableError {
  constructor(
    public readonly code: BindingConfigErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "BindingConfigError";
  }
}
