import { ActionableError } from "../../models";

/**
 * `setSensor` targeted a device with no emulator console: a physical Android
 * device or any iOS target (#14114). Typed so callers can tell an unsupported
 * target from a console or adb failure.
 */
export class EmulatorSensorUnsupportedError extends ActionableError {}
