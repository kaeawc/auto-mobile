/**
 * Device lifecycle operations reserved to broker provisioning.
 * It stays a name list rather than a tool trait (#15672): it names the hidden `startDevice`, which
 * `schemas/tool-definitions.json` deliberately omits, so a trait read from the committed definitions
 * could not reach it.
 */
export const BROKER_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
  "killDevice",
  "deleteDevice",
]);
