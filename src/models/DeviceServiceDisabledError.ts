import { ActionableError } from "./ActionableError";

export const DEVICE_SERVICE_DISABLED_CODE = "device_service_disabled";

export interface DeviceServiceDisabledDetails {
  tool: string;
  resource: string;
  labels: readonly string[];
  disabledLabels: readonly string[];
  unavailable: string;
  deviceId: string;
}

/** A known disabled simulator service requires an explicit configuration change. */
export class DeviceServiceDisabledError extends ActionableError {
  readonly code = DEVICE_SERVICE_DISABLED_CODE;
  readonly retryable = false;
  readonly tool: string;
  readonly resource: string;
  readonly labels: readonly string[];
  readonly disabledLabels: readonly string[];
  readonly unavailable: string;
  readonly howToEnable: string;
  readonly deviceId: string;

  constructor(details: DeviceServiceDisabledDetails) {
    const howToEnable = `Call setDeviceResources with {resources:{${details.resource}:"enabled"}} (enable this default-disabled tool with setToolEnabled or --enable-tool setDeviceResources), or provision/start the simulator without {resources:{${details.resource}:"disabled"}}.`;
    super(
      `${details.tool} requires resource ${details.resource} (${details.labels.join(", ")}); disabled labels: ${details.disabledLabels.join(", ")}. Unavailable: ${details.unavailable}. ${howToEnable}`,
    );
    this.name = "DeviceServiceDisabledError";
    this.tool = details.tool;
    this.resource = details.resource;
    this.labels = [...details.labels];
    this.disabledLabels = [...details.disabledLabels];
    this.unavailable = details.unavailable;
    this.howToEnable = howToEnable;
    this.deviceId = details.deviceId;
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      tool: this.tool,
      resource: this.resource,
      labels: this.labels,
      disabledLabels: this.disabledLabels,
      unavailable: this.unavailable,
      howToEnable: this.howToEnable,
      retryable: this.retryable,
      deviceId: this.deviceId,
    };
  }
}
