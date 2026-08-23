import { Mutex } from "async-mutex";
import { logger } from "../utils/logger";
import { defaultTimer, Timer } from "../utils/SystemTimer";

/**
 * Coordinates critical sections across multiple devices using global locks.
 * Ensures that devices wait at critical section boundaries and execute
 * their steps serially within the critical section.
 */
export class CriticalSectionCoordinator {
  private static instance: CriticalSectionCoordinator;
  private locks: Map<string, Mutex>;
  private barrierCounts: Map<string, Set<string>>; // lock -> set of device IDs that have arrived
  private expectedDeviceCounts: Map<string, number>; // lock -> expected device count
  private barrierResolvers: Map<string, Array<() => void>>; // lock -> resolvers waiting at barrier
  private cleanupTimers: Map<string, NodeJS.Timeout>; // lock -> cleanup timeout
  private readonly BARRIER_TIMEOUT_MS = 30000; // 30 seconds
  private readonly LOCK_CLEANUP_DELAY_MS = 5000; // 5 seconds after last device

  // Separator used to build the internal map key from an optional namespace and
  // the human lock name. NUL cannot appear in a plan-authored lock name or a
  // session UUID, so `namespace + SEP + lock` is collision-free.
  private static readonly NAMESPACE_SEPARATOR = "\u0000";

  // Injected timer seam (interface + fake per repo convention). Production uses
  // the real `defaultTimer`; tests inject a FakeTimer via createForTesting() so
  // barrier timeouts and cleanup delays are deterministic without global
  // setTimeout/Date.now patching.
  private readonly timer: Timer;

  private constructor(timer: Timer = defaultTimer) {
    this.timer = timer;
    this.locks = new Map();
    this.barrierCounts = new Map();
    this.expectedDeviceCounts = new Map();
    this.barrierResolvers = new Map();
    this.cleanupTimers = new Map();
  }

  public static getInstance(): CriticalSectionCoordinator {
    if (!CriticalSectionCoordinator.instance) {
      CriticalSectionCoordinator.instance = new CriticalSectionCoordinator();
    }
    return CriticalSectionCoordinator.instance;
  }

  /**
   * Create an isolated instance with an injected timer (for testing). Bypasses
   * the process-wide singleton so each test gets its own barrier state and its
   * own FakeTimer.
   */
  public static createForTesting(timer: Timer): CriticalSectionCoordinator {
    return new CriticalSectionCoordinator(timer);
  }

  /**
   * Build the internal map key for a lock. When a namespace is supplied (the
   * plan's base session UUID), it scopes the lock so two independent plans that
   * happen to reuse the same lock name get isolated barrier/mutex state instead
   * of colliding (issue: cross-plan barrier collision). Callers that pass no
   * namespace key by the bare lock name, preserving the pre-namespace behavior.
   */
  private scopedKey(lock: string, namespace?: string): string {
    return namespace
      ? `${namespace}${CriticalSectionCoordinator.NAMESPACE_SEPARATOR}${lock}`
      : lock;
  }

  /**
   * Registers the expected number of devices for a lock.
   * Must be called before any device arrives at the barrier.
   */
  public registerExpectedDevices(lock: string, deviceCount: number, namespace?: string): void {
    if (deviceCount < 1) {
      throw new Error(
        `Invalid device count ${deviceCount} for lock "${lock}". Must be at least 1.`,
      );
    }

    const key = this.scopedKey(lock, namespace);
    logger.debug(`Registering ${deviceCount} expected devices for lock "${lock}"`);
    this.expectedDeviceCounts.set(key, deviceCount);

    // Ensure lock mutex exists
    if (!this.locks.has(key)) {
      this.locks.set(key, new Mutex());
    }

    if (!this.barrierCounts.has(key)) {
      this.barrierCounts.set(key, new Set());
    }
    if (!this.barrierResolvers.has(key)) {
      this.barrierResolvers.set(key, []);
    }

    const existingTimer = this.cleanupTimers.get(key);
    if (existingTimer) {
      this.timer.clearTimeout(existingTimer);
      this.cleanupTimers.delete(key);
    }
  }

  /**
   * Wait at the barrier for all devices to arrive, then execute the critical section.
   * Returns a release function that must be called after execution completes.
   */
  public async enterCriticalSection(
    lock: string,
    deviceId: string,
    timeout: number = this.BARRIER_TIMEOUT_MS,
    namespace?: string,
  ): Promise<() => void> {
    const key = this.scopedKey(lock, namespace);
    logger.debug(`Device ${deviceId} entering critical section "${lock}"`);

    // Ensure lock exists
    if (!this.locks.has(key)) {
      this.locks.set(key, new Mutex());
    }

    // Wait at barrier
    await this.waitAtBarrier(key, deviceId, timeout, lock);

    // Acquire the mutex for serial execution
    logger.debug(`Device ${deviceId} acquiring lock "${lock}"`);
    const release = await this.locks.get(key)!.acquire();

    logger.debug(`Device ${deviceId} acquired lock "${lock}"`);

    // Return release function
    return () => {
      logger.debug(`Device ${deviceId} releasing lock "${lock}"`);
      release();
      this.scheduleCleanup(key);
    };
  }

  /**
   * Wait at a barrier until all expected devices arrive, then proceed
   * concurrently. Unlike {@link enterCriticalSection}, this acquires no mutex
   * and returns no release function: once the barrier lifts, every device
   * continues in parallel with no serialized section.
   *
   * Registers the expected device count (idempotently) before waiting, so each
   * participating device may call this with the same lock and deviceCount.
   * Schedules resource cleanup once the barrier lifts; on timeout the caller
   * should {@link forceCleanup} to release any devices still waiting.
   */
  public async awaitBarrier(
    lock: string,
    deviceId: string,
    deviceCount: number,
    timeout: number = this.BARRIER_TIMEOUT_MS,
    namespace?: string,
  ): Promise<void> {
    this.registerExpectedDevices(lock, deviceCount, namespace);
    const key = this.scopedKey(lock, namespace);
    await this.waitAtBarrier(key, deviceId, timeout, lock);
    this.scheduleCleanup(key);
  }

  /**
   * Wait at the barrier until all expected devices have arrived.
   *
   * Operates on the already-scoped map `key`; `label` is the human lock name
   * used only for log/error messages so namespaced keys never leak into
   * user-facing text.
   */
  private async waitAtBarrier(
    key: string,
    deviceId: string,
    timeout: number,
    label: string,
  ): Promise<void> {
    const expectedCount = this.expectedDeviceCounts.get(key);

    if (expectedCount === undefined) {
      throw new Error(
        `No expected device count registered for lock "${label}". ` +
          `Call registerExpectedDevices() before entering critical section.`,
      );
    }

    // Add this device to the barrier
    let arrivedDevices = this.barrierCounts.get(key);
    if (!arrivedDevices) {
      arrivedDevices = new Set();
      this.barrierCounts.set(key, arrivedDevices);
    }

    if (arrivedDevices.has(deviceId)) {
      throw new Error(
        `Device ${deviceId} already arrived at barrier for lock "${label}". ` +
          `Nested critical sections with the same lock are not supported.`,
      );
    }

    arrivedDevices.add(deviceId);
    const currentCount = arrivedDevices.size;

    logger.debug(
      `Device ${deviceId} arrived at barrier "${label}" (${currentCount}/${expectedCount})`,
    );

    // If all devices have arrived, release all waiting devices
    if (currentCount === expectedCount) {
      logger.debug(`All ${expectedCount} devices arrived at barrier "${label}", releasing all`);

      const resolvers = this.barrierResolvers.get(key) || [];
      this.barrierResolvers.set(key, []);

      // Release all waiting devices
      for (const resolve of resolvers) {
        resolve();
      }

      // Clear barrier state for potential reuse
      arrivedDevices.clear();

      return;
    }

    // Wait for other devices to arrive
    await new Promise<void>((resolve, reject) => {
      // Add to waiters
      const resolvers = this.barrierResolvers.get(key) || [];
      resolvers.push(resolve);
      this.barrierResolvers.set(key, resolvers);

      // Set timeout
      const timer = this.timer.setTimeout(() => {
        // Remove this resolver
        const currentResolvers = this.barrierResolvers.get(key) || [];
        const index = currentResolvers.indexOf(resolve);
        if (index > -1) {
          currentResolvers.splice(index, 1);
        }

        const arrivedCount = this.barrierCounts.get(key)?.size || 0;
        reject(
          new Error(
            `Timeout waiting for critical section "${label}". ` +
              `${arrivedCount}/${expectedCount} devices arrived after ${timeout}ms. ` +
              `Missing devices may have failed or not reached the critical section.`,
          ),
        );
      }, timeout);

      // Store the timeout so we can clear it if resolved normally
      const originalResolve = resolve;
      const wrappedResolve = () => {
        this.timer.clearTimeout(timer);
        originalResolve();
      };

      // Replace the resolver with the wrapped version
      const currentResolvers = this.barrierResolvers.get(key) || [];
      const resolverIndex = currentResolvers.indexOf(resolve);
      if (resolverIndex > -1) {
        currentResolvers[resolverIndex] = wrappedResolve;
      }
    });
  }

  /**
   * Schedule cleanup of lock resources after all devices have finished.
   */
  private scheduleCleanup(key: string): void {
    const existingTimer = this.cleanupTimers.get(key);
    if (existingTimer) {
      this.timer.clearTimeout(existingTimer);
    }

    // Schedule new cleanup
    const timer = this.timer.setTimeout(() => {
      logger.debug(`Cleaning up lock resources for "${key}"`);
      this.locks.delete(key);
      this.barrierCounts.delete(key);
      this.expectedDeviceCounts.delete(key);
      this.barrierResolvers.delete(key);
      this.cleanupTimers.delete(key);
    }, this.LOCK_CLEANUP_DELAY_MS);

    this.cleanupTimers.set(key, timer);
  }

  /**
   * Immediately clean up resources for a lock (used in error scenarios).
   *
   * Scoped by the same optional namespace as the other methods so one plan's
   * error-path cleanup cannot wipe a different plan's live lock state.
   */
  public forceCleanup(lock: string, namespace?: string): void {
    const key = this.scopedKey(lock, namespace);
    logger.debug(`Force cleaning up lock resources for "${lock}"`);

    const existingTimer = this.cleanupTimers.get(key);
    if (existingTimer) {
      this.timer.clearTimeout(existingTimer);
    }

    this.locks.delete(key);
    this.barrierCounts.delete(key);
    this.expectedDeviceCounts.delete(key);
    this.barrierResolvers.delete(key);
    this.cleanupTimers.delete(key);
  }

  /**
   * Reset all coordinator state (primarily for testing).
   */
  public reset(): void {
    for (const timer of this.cleanupTimers.values()) {
      this.timer.clearTimeout(timer);
    }

    this.locks.clear();
    this.barrierCounts.clear();
    this.expectedDeviceCounts.clear();
    this.barrierResolvers.clear();
    this.cleanupTimers.clear();
  }
}
