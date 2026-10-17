/**
 * Admission classes of the control socket's `ide/*` routes that are not plain control reads
 * (#11813). One table instead of method-name sets scattered through the server:
 *
 * - `startupProbe`: answered while the daemon is still starting, ahead of the MCP queue.
 * - `deviceMutation`: writes to a device or restarts its service, so it runs as one tracked
 *   control call under the owner's ownership gate (#11486).
 *
 * Every other `ide/*` and daemon-lifecycle method is a plain control call and needs no entry.
 */

import {
  parseClearKeyValueFileParams,
  parseRemoveKeyValueParams,
  parseSetFeatureFlagParams,
  parseSetKeyValueParams,
  parseSetSessionToolEnabledParams,
  parseUpdateServiceParams,
} from "./ideRouteParams";

export type IdeAdmissionClass = "startupProbe" | "deviceMutation";

export const IDE_ROUTE_ADMISSION = {
  "ide/status": "startupProbe",
  "ide/ping": "startupProbe",
  "ide/updateService": "deviceMutation",
  "ide/setKeyValue": "deviceMutation",
  "ide/removeKeyValue": "deviceMutation",
  "ide/clearKeyValueFile": "deviceMutation",
} as const satisfies Record<string, IdeAdmissionClass>;

function methodsOf(admission: IdeAdmissionClass): ReadonlySet<string> {
  return new Set(
    Object.entries(IDE_ROUTE_ADMISSION)
      .filter(([, value]) => value === admission)
      .map(([method]) => method),
  );
}

export const STARTUP_PROBE_METHODS: ReadonlySet<string> = methodsOf("startupProbe");

/** The `ide/*` routes that write to a device or restart its service: control calls (#11486). */
export const IDE_DEVICE_MUTATION_METHODS: ReadonlySet<string> = methodsOf("deviceMutation");

/** The params parser of each `ide/*` route that validates its own params. */
export const IDE_ROUTE_PARSERS = {
  "ide/setFeatureFlag": parseSetFeatureFlagParams,
  "ide/setSessionToolEnabled": parseSetSessionToolEnabledParams,
  "ide/updateService": parseUpdateServiceParams,
  "ide/setKeyValue": parseSetKeyValueParams,
  "ide/removeKeyValue": parseRemoveKeyValueParams,
  "ide/clearKeyValueFile": parseClearKeyValueFileParams,
} as const;
