import { ActionableError } from "./ActionableError";

/** SpringBoard launch exhausted the Home budget on a potentially busy simulator host (#11946). */
export class IosHomeLaunchTimeoutError extends ActionableError {
  readonly code = "timeout";
  readonly retryable = true;
}
