import { TemplateCloneCleanupError } from "./TemplateCloneCleanupError";
import type { SimulatorTemplateLock } from "./SimulatorTemplateLock";
import type { SimulatorCreateRequest } from "../../devices/SimulatorCreator";
import { runDetachedFromPerf } from "../../utils/PerfContext";
import { runWithAbortSignal } from "../../utils/AbortContext";
import type { SimCtlCatalog, SimulatorList } from "../../utils/ios-cmdline-tools/SimCtlSupport";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { SimulatorTemplateKey } from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
import { templateKeyHash, templateName } from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
import type {
  SimulatorTemplateManifest,
  SimulatorTemplateManifestStore,
} from "./SimulatorTemplateManifestStore";
import type { XcodeVersionReader } from "./XcodeVersionReader";
export interface TemplateSimulatorClient {
  createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string>;
  cloneSimulator(udid: string, name: string, signal?: AbortSignal): Promise<string>;
  listSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<SimulatorList>;
  getCatalogChecked(signal?: AbortSignal): Promise<SimCtlCatalog>;
  deleteSimulator(udid: string, options?: { signal?: AbortSignal }): Promise<void>;
}
export interface TemplateBuildRequester {
  build(key: SimulatorTemplateKey, signal?: AbortSignal): Promise<unknown>;
}
export interface TemplateCreationDependencies {
  client: TemplateSimulatorClient;
  store: SimulatorTemplateManifestStore;
  lock: SimulatorTemplateLock;
  xcode: XcodeVersionReader;
  timer: Pick<Timer, "now">;
  profile(): SimulatorTemplateKey["profile"];
  builder: TemplateBuildRequester;
}
export class SimulatorCreationService {
  private readonly cloneFailures = new Map<string, number>();
  private readonly lifetime = new AbortController();
  async stop(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled(this.flights.values());
  }
  private readonly flights = new Map<string, Promise<unknown>>();
  constructor(
    private readonly creator: Pick<TemplateSimulatorClient, "createSimulator">,
    private readonly enabled: () => boolean,
    private readonly dependencies: () => TemplateCreationDependencies,
  ) {}
  async create(
    request: SimulatorCreateRequest,
    context?: {
      creator: Pick<TemplateSimulatorClient, "createSimulator">;
      dependencies: () => TemplateCreationDependencies;
    },
  ): Promise<{ udid: string; source: "clone" | "create" }> {
    request.signal?.throwIfAborted();
    if (this.enabled()) {
      try {
        const clone = await this.tryClone(request, context?.dependencies());
        if (clone) {
          return { udid: clone, source: "clone" };
        }
      } catch (error) {
        if (error instanceof TemplateCloneCleanupError) {
          throw error;
        }
        logger.warn(`Template lookup failed; creating simulator: ${errorMessage(error)}`, error);
        request.signal?.throwIfAborted();
      }
    }
    return {
      udid: await (context?.creator ?? this.creator).createSimulator(
        request.name,
        request.deviceType,
        request.runtime,
        request.signal,
      ),
      source: "create",
    };
  }
  private async tryClone(
    request: SimulatorCreateRequest,
    deps: TemplateCreationDependencies = this.dependencies(),
  ): Promise<string | undefined> {
    const key = await this.resolveKey(deps, request);
    if (!key) {
      return undefined;
    }
    const manifest = await deps.store.read(key);
    if (manifest && !this.buildsMatch(manifest, key)) {
      await this.markStale(deps, manifest, request.signal);
    }
    if (manifest?.state === "ready" && this.buildsMatch(manifest, key)) {
      const result = await this.cloneReady(deps, manifest, request);
      if (result.preserveTemplate) {
        return result.udid;
      }
      await this.markStale(deps, manifest, request.signal);
    }
    if ((manifest?.nextAttemptAtMs ?? 0) <= deps.timer.now()) {
      this.requestBuild(deps, key);
    }
    return undefined;
  }
  private buildsMatch(manifest: SimulatorTemplateManifest, key: SimulatorTemplateKey): boolean {
    return manifest.xcodeBuild === key.xcodeBuild && manifest.runtimeBuild === key.runtimeBuild;
  }
  private async resolveKey(
    deps: TemplateCreationDependencies,
    request: SimulatorCreateRequest,
  ): Promise<SimulatorTemplateKey | undefined> {
    const runtime = (await deps.client.getCatalogChecked(request.signal)).runtimes.find(
      (entry) => entry.identifier === request.runtime,
    );
    if (!runtime?.buildversion) {
      return undefined;
    }
    const xcodeBuild = await deps.xcode.readBuild(request.signal);
    if (xcodeBuild === "unknown") {
      return undefined;
    }
    return {
      xcodeBuild,
      runtime: request.runtime,
      runtimeBuild: runtime.buildversion,
      deviceType: request.deviceType,
      profile: deps.profile(),
    };
  }
  private async cloneReady(
    deps: TemplateCreationDependencies,
    manifest: SimulatorTemplateManifest,
    request: SimulatorCreateRequest,
  ): Promise<{ udid?: string; preserveTemplate: boolean }> {
    const sims = await deps.client.listSimulators(undefined, request.signal);
    const sim = Object.values(sims.devices)
      .flat()
      .find((entry) => entry.udid === manifest.udid);
    if (sim?.state !== "Shutdown" || sim.name !== templateName(manifest.key)) {
      return { preserveTemplate: sim?.name === templateName(manifest.key) };
    }
    const before = new Set(
      Object.values(sims.devices)
        .flat()
        .map((entry) => entry.udid),
    );
    try {
      const udid = await deps.client.cloneSimulator(manifest.udid, request.name, request.signal);
      this.cloneFailures.delete(manifest.udid);
      return { udid, preserveTemplate: true };
    } catch (error) {
      logger.warn(`Template clone failed: ${errorMessage(error)}`, error);
      let failures = this.cloneFailures.get(manifest.udid) ?? 0;
      if (!request.signal?.aborted) {
        failures++;
        this.cloneFailures.set(manifest.udid, failures);
      }
      const preserveTemplate = await runWithAbortSignal(undefined, async () => {
        await this.removeFailedClone(deps, { ...request, signal: undefined }, before);
        const after = await deps.client.listSimulators();
        const template = Object.values(after.devices)
          .flat()
          .find((entry) => entry.udid === manifest.udid);
        return (
          template?.name === templateName(manifest.key) &&
          (template.state !== "Shutdown" || request.signal?.aborted === true || failures < 2)
        );
      });
      if (request.signal?.aborted) {
        if (!preserveTemplate) {
          await runWithAbortSignal(undefined, () => this.markStale(deps, manifest));
        }
        request.signal.throwIfAborted();
      }
      return { preserveTemplate };
    }
  }
  private async removeFailedClone(
    deps: TemplateCreationDependencies,
    request: SimulatorCreateRequest,
    before: ReadonlySet<string>,
  ): Promise<void> {
    try {
      const after = await deps.client.listSimulators(undefined, request.signal);
      for (const entry of Object.values(after.devices).flat()) {
        if (entry.name === request.name && !before.has(entry.udid)) {
          await deps.client.deleteSimulator(entry.udid, { signal: request.signal });
        }
      }
    } catch (error) {
      throw new TemplateCloneCleanupError(error);
    }
  }
  private async markStale(
    deps: TemplateCreationDependencies,
    manifest: SimulatorTemplateManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    const release = await deps.lock.acquire(manifest.key, signal);
    if (!release) {
      return;
    }
    try {
      const current = await deps.store.read(manifest.key);
      if (current?.udid === manifest.udid && current.state === "ready") {
        await deps.store.write({ ...current, state: "stale" });
        this.cloneFailures.delete(manifest.udid);
      }
    } finally {
      release();
    }
  }
  private requestBuild(deps: TemplateCreationDependencies, key: SimulatorTemplateKey): void {
    const hash = templateKeyHash(key);
    if (this.flights.has(hash)) {
      return;
    }
    const flight = runDetachedFromPerf(() =>
      runWithAbortSignal(this.lifetime.signal, () =>
        Promise.resolve()
          .then(() => deps.builder.build(key, this.lifetime.signal))
          .catch((error) => {
            logger.warn(`Background template build failed: ${errorMessage(error)}`, error);
          })
          .finally(() => {
            this.flights.delete(hash);
          }),
      ),
    );
    this.flights.set(hash, flight);
  }
}
