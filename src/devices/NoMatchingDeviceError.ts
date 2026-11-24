import { ActionableError } from "../models/ActionableError";

/**
 * No running device or configured image satisfies a selector boot, and the request may not create
 * one. Typed so a caller that chose the selector itself (a bare getAndroid, #19124) can name the
 * identifiers that pick a device instead of the criteria the caller never wrote.
 */
export class NoMatchingDeviceError extends ActionableError {}
