import { ActionableError } from "./ActionableError";
import type { IosDeviceResourceHazard } from "./IosDeviceResourceHazard";

export const UNSAFE_DEVICE_RESOURCE_COMBINATION_CODE = "unsafe_device_resource_combination";

/** A resource combination requires an explicit configuration change before device work. */
export class UnsafeDeviceResourceCombinationError extends ActionableError {
  readonly code = UNSAFE_DEVICE_RESOURCE_COMBINATION_CODE;
  readonly retryable = false;
  readonly hazards: readonly IosDeviceResourceHazard[];
  readonly howToProceed: string;

  constructor(hazards: readonly IosDeviceResourceHazard[]) {
    const howToProceed =
      "Drop or re-enable at least one of the listed resources in each unsafe combination before retrying.";
    super(
      `Unsafe iOS device resource combination: ${hazards.map((hazard) => `${hazard.id} (${hazard.resources.join(", ")}): ${hazard.reason}`).join("; ")}. ${howToProceed}`,
    );
    this.name = "UnsafeDeviceResourceCombinationError";
    this.hazards = hazards.map((hazard) => ({
      ...hazard,
      resources: [...hazard.resources],
      appliesTo: [...hazard.appliesTo],
    }));
    this.howToProceed = howToProceed;
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      retryable: this.retryable,
      hazards: this.hazards,
      howToProceed: this.howToProceed,
    };
  }
}
