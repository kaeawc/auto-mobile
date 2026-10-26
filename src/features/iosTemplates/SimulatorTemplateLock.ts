import type { ExclusiveLockOptions } from "../../utils/fileLock";
import { join } from "node:path";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import {
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
  readLockOwnerPid,
} from "../../utils/fileLock";
import { defaultLockOwnerGenerationProbe } from "../../daemon/lockOwnerGeneration";
import { ensureSecureDirectorySync, getHostGlobalAutoMobileDir } from "../../utils/tempDir";
import type { Timer } from "../../utils/SystemTimer";
import {
  templateKeyHash,
  type SimulatorTemplateKey,
} from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
export interface SimulatorTemplateLock {
  acquire(key: SimulatorTemplateKey, signal?: AbortSignal): Promise<(() => void) | undefined>;
  acquireName(name: string, signal?: AbortSignal): Promise<(() => void) | undefined>;
}
export class FileSimulatorTemplateLock implements SimulatorTemplateLock {
  constructor(
    private readonly timer: Timer,
    private readonly directory: () => string = () =>
      ensureSecureDirectorySync(getHostGlobalAutoMobileDir("ios-sim-templates")),
    private readonly options: ExclusiveLockOptions = {},
  ) {}
  private path(key: SimulatorTemplateKey): string {
    return join(this.directory(), `${templateKeyHash(key)}.lock`);
  }
  async acquire(
    key: SimulatorTemplateKey,
    signal?: AbortSignal,
  ): Promise<(() => void) | undefined> {
    return this.acquirePath(this.path(key), signal);
  }
  acquireName(name: string, signal?: AbortSignal): Promise<(() => void) | undefined> {
    const hash = /^automobile-template-([a-f0-9]{8})$/.exec(name)?.[1];
    if (!hash) {
      throw new Error("Invalid template name");
    }
    return this.acquirePath(join(this.directory(), `${hash}.lock`), signal);
  }
  private async acquirePath(path: string, signal?: AbortSignal): Promise<(() => void) | undefined> {
    const token = (this.options.idGenerator ?? defaultIdGenerator).next();
    // Bounded retry only for a publication race; another daemon owns long builds.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      if (
        tryAcquireExclusiveLock(path, {
          ...this.options,
          ownerToken: token,
          ownerGeneration: this.options.ownerGeneration ?? defaultLockOwnerGenerationProbe,
        })
      ) {
        return () =>
          releaseExclusiveLock(
            path,
            this.options.pid ?? process.pid,
            token,
            this.options.fileSystem,
          );
      }
      if (
        readLockOwnerPid(
          path,
          this.options.isProcessRunning,
          this.options.ownerGeneration ?? defaultLockOwnerGenerationProbe,
          this.options.fileSystem,
        ) !== undefined ||
        attempt === 1
      ) {
        return undefined;
      }
      await this.timer.sleep(25);
    }
    return undefined;
  }
}
