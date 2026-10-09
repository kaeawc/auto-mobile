import type { AppleDevice } from "./SimCtlClient";

/** Shape of `xcrun simctl list devices --json`; the one place its stdout is parsed. */
export interface SimctlDeviceList {
  devices: { [runtimeId: string]: AppleDevice[] };
}

/** Parses `simctl list devices` JSON; throws on malformed JSON so callers report the failure. */
export function parseSimctlDeviceList(stdout: string): SimctlDeviceList {
  return JSON.parse(stdout) as SimctlDeviceList;
}
