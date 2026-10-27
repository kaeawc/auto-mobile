import { ActionableError } from "./ActionableError";

/** Admission refusal preserves the selected serial until its identity is resolved. */
export class DeviceIdentityQuarantinedError extends ActionableError {}
