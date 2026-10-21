import { ActionableError } from "../../../models/ActionableError";

/** A non-2xx response, with Google's canonical error status (e.g. `FAILED_PRECONDITION`). */
export class DeviceStreamingApiError extends ActionableError {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly status?: string,
  ) {
    super(message);
  }
}
