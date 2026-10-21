import { ActionableError } from "./ActionableError";

/** A device command received no answer; no device-side recovery attempt was made. */
export class DeviceUnreachableError extends ActionableError {}
