export class ObserverPendingRequestTimeoutError extends Error {
  constructor() {
    super("Owner's in-flight request exceeded the observer hierarchy deadline");
  }
}
