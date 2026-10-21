/** Device lifecycle operations reserved to broker provisioning. */
export const BROKER_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
  "killDevice",
  "deleteDevice",
]);
