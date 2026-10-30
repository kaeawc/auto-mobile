import type { BootedDevice, ViewHierarchyResult } from "../../models";
import { type PerformanceTracker } from "../../utils/PerformanceTracker";
import { RequestManager } from "../../utils/RequestManager";
import { type Timer } from "../../utils/SystemTimer";
import { waitForPendingRequests } from "./deviceServiceClientWaits";
import {
  buildScreenshotBackoffScheduler,
  forwardHierarchyToObservationStream,
} from "./deviceServiceObservationStream";
import {
  DefaultScreenshotBackoffScheduler,
  type ScreenshotBackoffScheduler,
  type ScreenshotCaptureResult,
} from "./ScreenshotBackoffScheduler";
import type { CtrlSocket, DelegateContext } from "./shared/types";
export abstract class DeviceServiceClientDelegates {
  protected abstract timer: Timer;
  protected abstract requestManager: RequestManager;
  protected abstract ws: CtrlSocket | null;
  protected abstract device: BootedDevice;
  protected abstract screenshotBackoffScheduler: ScreenshotBackoffScheduler | null;
  abstract ensureConnected(perf?: PerformanceTracker): Promise<boolean>;
  protected abstract cancelScreenshotBackoff(): void;

  protected async waitForPendingRequests(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return waitForPendingRequests(
      { timer: this.timer, requestManager: this.requestManager },
      timeoutMs,
      signal,
    );
  }

  // ===========================================================================
  // Utility methods for subclasses
  // ===========================================================================

  /**
   * Get the RequestManager instance for use by subclasses.
   */
  protected getRequestManager(): RequestManager {
    return this.requestManager;
  }

  /**
   * Get the Timer instance for use by subclasses.
   */
  protected getTimer(): Timer {
    return this.timer;
  }

  // ===========================================================================
  // Delegate context + lazy delegate scaffolding (shared implementation)
  // ===========================================================================

  /**
   * Platform-specific additions to the base {@link DelegateContext}.
   *
   * The base builds the fields common to both platforms; a subclass overrides
   * this hook to contribute the fields only it wires (e.g. iOS's command-
   * capability accessors). The default contributes nothing, so a platform whose
   * context is exactly the shared set (Android) needs no override.
   */
  protected extraDelegateContextFields(): Partial<DelegateContext> {
    return {};
  }

  /**
   * Build the base {@link DelegateContext} handed to every delegate.
   *
   * The shared fields are wired here from base state; platform-specific fields
   * come from {@link extraDelegateContextFields}. Subclasses that need an
   * extended context (e.g. a HierarchyDelegateContext) spread the result of this
   * method and add their own fields.
   */
  protected createDelegateContext(): DelegateContext {
    return {
      getWebSocket: () => this.ws,
      requestManager: this.requestManager,
      timer: this.timer,
      ensureConnected: (perf) => this.ensureConnected(perf),
      cancelScreenshotBackoff: () => this.cancelScreenshotBackoff(),
      ...this.extraDelegateContextFields(),
    };
  }

  /**
   * Lazily construct and cache a delegate, replacing the copy-pasted
   * `if (!this._x) { this._x = new X(...); } return this._x;` getter body.
   *
   * The cache slot stays a subclass field (accessed through the get/set pair)
   * so existing direct-field reads keep working and the singleton semantics are
   * unchanged: the factory runs at most once and the same instance is returned
   * on every subsequent access.
   */
  protected lazyDelegate<T>(get: () => T | null, set: (value: T) => void, factory: () => T): T {
    const existing = get();
    if (existing) {
      return existing;
    }
    const created = factory();
    set(created);
    return created;
  }

  protected forwardHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    frameContext: string | undefined,
    hooks: {
      logTag: string;
      prepare?: () => void;
      recordForwarded: (captureSequence: number) => void;
    },
  ): void {
    return forwardHierarchyToObservationStream(
      this.device.deviceId,
      hierarchy,
      frameContext,
      hooks,
    );
  }

  protected createScreenshotBackoffScheduler(
    capture: () => Promise<ScreenshotCaptureResult>,
    emit: (result: ScreenshotCaptureResult) => void,
    options: ConstructorParameters<typeof DefaultScreenshotBackoffScheduler>[2],
  ): ScreenshotBackoffScheduler {
    return (this.screenshotBackoffScheduler ??= buildScreenshotBackoffScheduler(
      this.device.deviceId,
      this.timer,
      capture,
      { emit, options },
    ));
  }
}
