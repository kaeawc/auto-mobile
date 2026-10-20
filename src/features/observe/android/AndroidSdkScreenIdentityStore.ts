/**
 * The newest AutoMobile SDK navigation route per reporting package, as a screen identity, with
 * waiters for a route newer than a given host time. Extracted from `AndroidCtrlProxyClient`
 * (#11846); behaviour is unchanged.
 */
import type { ScreenIdentity } from "../../../models/ObserveResult";
import type { Timer } from "../../../utils/SystemTimer";

interface SdkRouteWaiter {
  sinceMs: number;
  settle(identity: ScreenIdentity | undefined): void;
}

export class AndroidSdkScreenIdentityStore {
  /** Newest AutoMobile SDK navigation route per reporting package, as a screen identity. */
  private readonly identities = new Map<
    string,
    { identity: ScreenIdentity; receivedAtMs: number }
  >();
  /** Callers waiting for a route newer than a given host time, keyed by reporting package. */
  private readonly waiters = new Map<string, Set<SdkRouteWaiter>>();

  constructor(private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">) {}

  /**
   * The newest AutoMobile SDK navigation route the app reported, when the app embeds the SDK.
   * Single-activity Compose apps name their screens only this way.
   */
  get(applicationId?: string): ScreenIdentity | undefined {
    return applicationId ? this.identities.get(applicationId)?.identity : undefined;
  }

  /** Host time (this client's timer) at which the app's newest SDK route arrived. */
  getReceivedAtMs(applicationId: string): number | undefined {
    return this.identities.get(applicationId)?.receivedAtMs;
  }

  /**
   * Resolve with the app's SDK route once one newer than `sinceMs` has arrived, or undefined after
   * `timeoutMs` (or when the app's route is cleared first). Returns at once for a route that
   * already postdates `sinceMs`.
   */
  awaitAfter(
    applicationId: string,
    sinceMs: number,
    timeoutMs: number,
  ): Promise<ScreenIdentity | undefined> {
    const current = this.identities.get(applicationId);
    if (current && current.receivedAtMs > sinceMs) {
      return Promise.resolve(current.identity);
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(applicationId) ?? new Set();
      this.waiters.set(applicationId, waiters);
      const waiter: SdkRouteWaiter = {
        sinceMs,
        settle: (identity) => {
          this.timer.clearTimeout(handle);
          waiters.delete(waiter);
          resolve(identity);
        },
      };
      const handle = this.timer.setTimeout(() => waiter.settle(undefined), timeoutMs);
      waiters.add(waiter);
    });
  }

  /**
   * Forget the SDK navigation route of an app whose process was replaced (terminated, relaunched
   * cold, data cleared, crashed), or of every app when none is named (the SDK link was lost). The
   * next route event the new process reports is the only thing that names its screen again.
   */
  clear(applicationId?: string): void {
    const applicationIds = applicationId
      ? [applicationId]
      : [...new Set([...this.identities.keys(), ...this.waiters.keys()])];
    for (const id of applicationIds) {
      this.identities.delete(id);
      for (const waiter of [...(this.waiters.get(id) ?? [])]) {
        waiter.settle(undefined);
      }
    }
  }

  record(applicationId: string, identity: ScreenIdentity): void {
    const receivedAtMs = this.timer.now();
    this.identities.set(applicationId, { identity, receivedAtMs });
    for (const waiter of [...(this.waiters.get(applicationId) ?? [])]) {
      if (receivedAtMs > waiter.sinceMs) {
        waiter.settle(identity);
      }
    }
  }
}
