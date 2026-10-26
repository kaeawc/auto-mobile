import { deleteTemplateSimulator } from "./templateSafety";
import { runWithAbortSignal } from "../../utils/AbortContext";
import type { IosBootInstrumentation } from "../../models/IosBootInstrumentation";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { SimulatorPrebootProfile } from "../../utils/ios-cmdline-tools/SimulatorPrebootProfile";
import type { Timer } from "../../utils/SystemTimer";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  templateKeyHash,
  templateName,
  type SimulatorTemplateKey,
} from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
import type {
  SimulatorTemplateManifest,
  SimulatorTemplateManifestStore,
} from "./SimulatorTemplateManifestStore";
import type { SimulatorTemplateLock } from "./SimulatorTemplateLock";
import type { TemplateSimulatorClient } from "./SimulatorCreationService";
import type { XcodeVersionReader } from "./XcodeVersionReader";
import {
  TEMPLATE_CPU_MEAN_WINDOW_MS,
  TEMPLATE_CPU_THRESHOLD_PERCENT,
  TEMPLATE_MAX_WAIT_MS,
  TEMPLATE_QUIET_WINDOW_MS,
  type SettleDetector,
} from "./SettleDetector";
export interface TemplateBuildDependencies {
  client: TemplateSimulatorClient & {
    boot(udid: string, signal?: AbortSignal): Promise<void>;
    shutdownSimulator(udid: string, signal?: AbortSignal): Promise<void>;
  };
  store: SimulatorTemplateManifestStore;
  lock: SimulatorTemplateLock;
  xcode: XcodeVersionReader;
  profile(key: SimulatorTemplateKey): Pick<SimulatorPrebootProfile, "apply">;
  instrumentation: IosBootInstrumentation;
  settle: SettleDetector;
  timer: Timer;
  backoff?: BackoffPolicy;
  hasSpareCapacity?(): Promise<boolean>;
}
export type TemplateBuildResult = "ready" | "building elsewhere" | "retry later" | "failed";
export class SimulatorTemplateBuilder {
  private readonly flights = new Map<string, Promise<TemplateBuildResult>>();
  constructor(private readonly deps: TemplateBuildDependencies) {}
  build(key: SimulatorTemplateKey, signal?: AbortSignal): Promise<TemplateBuildResult> {
    const hash = templateKeyHash(key);
    const existing = this.flights.get(hash);
    if (existing) {
      return existing;
    }
    const flight = this.buildLocked(key, signal).finally(() => {
      this.flights.delete(hash);
    });
    this.flights.set(hash, flight);
    return flight;
  }
  private async buildLocked(
    key: SimulatorTemplateKey,
    signal?: AbortSignal,
  ): Promise<TemplateBuildResult> {
    const release = await this.deps.lock.acquire(key, signal);
    if (!release) {
      return "building elsewhere";
    }
    try {
      signal?.throwIfAborted();
      if (!(await this.inputsAvailable(key, signal))) {
        return "retry later";
      }
      const previous = await this.deps.store.read(key);
      if ((previous?.nextAttemptAtMs ?? 0) > this.deps.timer.now()) {
        return "retry later";
      }
      const xcodeBuild = key.xcodeBuild;
      const untracked = await this.scanUntracked(key, previous, signal);
      const ready = await this.readyStatus(previous, xcodeBuild, signal);
      if (ready) {
        return ready;
      }
      if (previous?.udid) {
        await deleteTemplateSimulator(this.deps.client, key, previous.udid, signal);
      }
      const manifest: SimulatorTemplateManifest = {
        attempt: previous?.attempt ?? 0,
        key,
        udid: "",
        state: "building",
        xcodeBuild,
        runtimeBuild: key.runtimeBuild,
        builtAtMs: this.deps.timer.now(),
      };
      return await this.populate(manifest, untracked, signal);
    } finally {
      release();
    }
  }
  private async inputsAvailable(key: SimulatorTemplateKey, signal?: AbortSignal): Promise<boolean> {
    if (this.deps.hasSpareCapacity && !(await this.deps.hasSpareCapacity())) {
      return false;
    }
    const { runtimes } = await this.deps.client.getCatalogChecked(signal);
    if (
      !runtimes.some(
        (runtime) =>
          runtime.identifier === key.runtime && runtime.buildversion === key.runtimeBuild,
      )
    ) {
      return false;
    }
    const xcode = await this.deps.xcode.readBuild(signal);
    return xcode !== "unknown" && xcode === key.xcodeBuild;
  }
  private async scanUntracked(
    key: SimulatorTemplateKey,
    previous: SimulatorTemplateManifest | undefined,
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    const untracked = new Set<string>();
    const list = await this.deps.client.listSimulators(undefined, signal);
    for (const sim of Object.values(list.devices).flat()) {
      if (sim.name === templateName(key) && sim.udid !== previous?.udid) {
        untracked.add(sim.udid);
        logger.warn(
          `leaving untracked template simulator ${sim.udid} (${sim.state}); not owned by this manifest, remove with the ios-templates clean command`,
        );
      }
    }
    return untracked;
  }
  private async readyStatus(
    manifest: SimulatorTemplateManifest | undefined,
    xcodeBuild: string,
    signal?: AbortSignal,
  ): Promise<TemplateBuildResult | undefined> {
    if (!manifest) {
      return undefined;
    }
    const list = await this.deps.client.listSimulators(undefined, signal);
    const sim = Object.values(list.devices)
      .flat()
      .find((sim) => sim.udid === manifest.udid && sim.name === templateName(manifest.key));
    if (sim && sim.state !== "Shutdown") {
      if (manifest.state === "ready" || manifest.state === "stale") {
        logger.warn(`Template ${sim.udid} is ${sim.state}; possibly in use, retry later`);
        return "retry later";
      }
      // The host-global key lock excludes a live writer for this manifest-owned simulator.
      try {
        await this.deps.client.shutdownSimulator(sim.udid, signal);
      } catch (error) {
        logger.warn(
          `Could not shut down interrupted template ${sim.udid}: ${errorMessage(error)}`,
          error,
        );
      }
    }
    return sim &&
      manifest.state === "ready" &&
      manifest.xcodeBuild === xcodeBuild &&
      manifest.runtimeBuild === manifest.key.runtimeBuild &&
      manifest.xcodeBuild === manifest.key.xcodeBuild
      ? "ready"
      : undefined;
  }
  private async populate(
    manifest: SimulatorTemplateManifest,
    untracked: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<TemplateBuildResult> {
    const { client, store, timer } = this.deps;
    await store.write(manifest);
    try {
      manifest.udid = await client.createSimulator(
        templateName(manifest.key),
        manifest.key.deviceType,
        manifest.key.runtime,
        signal,
      );
      await store.write(manifest);
      const applied = await this.deps.profile(manifest.key).apply(manifest.udid, {}, signal);
      if (!applied.applied && manifest.key.profile !== "none") {
        throw new Error(
          `Template preboot profile was not applied: ${applied.reason ?? "unknown reason"}`,
        );
      }
      signal?.throwIfAborted();
      await this.deps.instrumentation.run(
        {
          udid: manifest.udid,
          runtime: manifest.key.runtime,
          reason: "create",
          timeoutMs: TEMPLATE_MAX_WAIT_MS,
          signal,
        },
        async () => {
          await client.boot(manifest.udid, signal);
        },
      );
      await this.deps.settle.waitUntilSettled(manifest.udid, {
        quietWindowMs: TEMPLATE_QUIET_WINDOW_MS,
        cpuThresholdPercent: TEMPLATE_CPU_THRESHOLD_PERCENT,
        cpuMeanWindowMs: TEMPLATE_CPU_MEAN_WINDOW_MS,
        maxWaitMs: TEMPLATE_MAX_WAIT_MS,
        signal,
      });
      manifest.settledAtMs = timer.now();
      await client.shutdownSimulator(manifest.udid, signal);
      const list = await client.listSimulators(undefined, signal);
      if (
        !Object.values(list.devices)
          .flat()
          .some(
            (sim) =>
              sim.udid === manifest.udid &&
              sim.name === templateName(manifest.key) &&
              sim.state === "Shutdown",
          )
      ) {
        throw new Error("Template did not shut down");
      }
      signal?.throwIfAborted();
      await store.write({
        ...manifest,
        state: "ready",
        attempt: 0,
        failure: undefined,
        nextAttemptAtMs: undefined,
      });
      return "ready";
    } catch (error) {
      return this.recordFailure(manifest, untracked, error, signal?.aborted === true);
    }
  }
  private async recordFailure(
    manifest: SimulatorTemplateManifest,
    untracked: ReadonlySet<string>,
    error: unknown,
    interrupted = false,
  ): Promise<TemplateBuildResult> {
    const { store, timer } = this.deps;
    logger.warn(`Template build did not complete: ${errorMessage(error)}`, error);
    const retainedUdid = await runWithAbortSignal(undefined, () =>
      this.removePartial(manifest, untracked),
    );
    const refused = error instanceof BootCapacityExhaustedError;
    if (interrupted) {
      // The user stopped the build: it is not a failed attempt, so no retry backoff (#15312).
      await store.write({ ...manifest, udid: retainedUdid, state: "failed", failure: undefined });
      return "failed";
    }
    const attempt = (manifest.attempt ?? 0) + (refused ? 0 : 1);
    const delay = refused
      ? 60_000
      : (
          this.deps.backoff ??
          exponentialBackoff({ initialDelayMs: 60_000, maxDelayMs: 6 * 60 * 60_000 })
        ).delayForAttempt(attempt);
    const nextAttemptAtMs = timer.now() + delay;
    await store.write({
      ...manifest,
      udid: retainedUdid,
      attempt,
      state: refused ? "stale" : "failed",
      nextAttemptAtMs,
      failure: refused ? undefined : { atMs: timer.now(), reason: errorMessage(error) },
    });
    return refused ? "retry later" : "failed";
  }

  private async removePartial(
    manifest: SimulatorTemplateManifest,
    untracked: ReadonlySet<string>,
  ): Promise<string> {
    let udid = manifest.udid;
    try {
      if (!udid) {
        const list = await this.deps.client.listSimulators();
        udid =
          Object.values(list.devices)
            .flat()
            .find((sim) => sim.name === templateName(manifest.key) && !untracked.has(sim.udid))
            ?.udid ?? "";
      }
      if (udid) {
        await deleteTemplateSimulator(this.deps.client, manifest.key, udid);
      }
      return "";
    } catch (error) {
      logger.warn(`Could not delete partial template ${udid}: ${errorMessage(error)}`, error);
      return udid;
    }
  }
}
