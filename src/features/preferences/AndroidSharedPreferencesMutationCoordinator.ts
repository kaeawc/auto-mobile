/**
 * Serializes whole-file Android SharedPreferences XML mutations by physical
 * target. Direct XML writes are read-modify-write operations, so their read,
 * edit, and write must share one turn across every entry point that can touch
 * the same device/app/file.
 */
export interface AndroidSharedPreferencesMutationCoordinator {
  /** `userId` defaults to 0 so the unscoped (`run-as` without `--user`) path shares user 0's queue. */
  run<T>(
    deviceId: string,
    appId: string,
    fileName: string,
    mutation: () => Promise<T>,
    userId?: number,
  ): Promise<T>;
}

export class PerFileAndroidSharedPreferencesMutationCoordinator implements AndroidSharedPreferencesMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(
    deviceId: string,
    appId: string,
    fileName: string,
    mutation: () => Promise<T>,
    userId = 0,
  ): Promise<T> {
    const key = JSON.stringify(
      userId === 0 ? [deviceId, appId, fileName] : [deviceId, appId, fileName, userId],
    );
    const prior = this.tails.get(key) ?? Promise.resolve();
    const result = prior.then(mutation, mutation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }
}

const defaultCoordinator = new PerFileAndroidSharedPreferencesMutationCoordinator();

/** Shared coordinator used by all Android SharedPreferences XML mutation routes. */
export function getAndroidSharedPreferencesMutationCoordinator(): AndroidSharedPreferencesMutationCoordinator {
  return defaultCoordinator;
}
