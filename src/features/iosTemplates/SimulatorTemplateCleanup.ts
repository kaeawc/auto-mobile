import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import {
  isTemplateSimName,
  templateName,
  type SimulatorTemplateKey,
} from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
import type { TemplateSimulatorClient } from "./SimulatorCreationService";
import type {
  SimulatorTemplateManifest,
  SimulatorTemplateManifestStore,
} from "./SimulatorTemplateManifestStore";
import type { SimulatorTemplateLock } from "./SimulatorTemplateLock";
import { deleteTemplateSimulator } from "./templateSafety";
export type TemplateCleanupOptions = (
  | { all: true; key?: never; runtime?: never; stale?: never }
  | { key: SimulatorTemplateKey; all?: never; runtime?: never; stale?: never }
  | { runtime: string; all?: never; key?: never; stale?: never }
  | { stale: true; all?: never; key?: never; runtime?: never }
) & { force?: boolean; signal?: AbortSignal };
export class SimulatorTemplateCleanup {
  constructor(
    private readonly client: Pick<TemplateSimulatorClient, "deleteSimulator" | "listSimulators">,
    private readonly store: SimulatorTemplateManifestStore,
    private readonly lock: SimulatorTemplateLock,
    private readonly isStale?: (manifest: SimulatorTemplateManifest) => Promise<boolean>,
  ) {}
  async clean(options: TemplateCleanupOptions): Promise<void> {
    const keys = await this.keys(options);
    const handled = new Set<string>();
    const refused: string[] = [];
    for (const key of keys) {
      const name = templateName(key);
      handled.add(name);
      const release = await this.lock.acquire(key, options.signal);
      if (!release && !options.force) {
        refused.push(name);
        continue;
      }
      try {
        await this.cleanKey(key, Boolean(release), options.signal);
      } finally {
        release?.();
      }
    }
    if (options.all) {
      await this.removeOrphans(handled, options, refused);
    }
    if (options.all || options.runtime) {
      await this.store.removeInvalid?.(options.runtime);
    }
    if (refused.length) {
      throw new ActionableError(
        `Templates under a live lock: ${refused.join(", ")}. Retry later or use --force.`,
      );
    }
  }
  private async cleanKey(
    key: SimulatorTemplateKey,
    locked: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.store.read(key);
    if (current?.udid) {
      await deleteTemplateSimulator(this.client, key, current.udid, signal);
    }
    // Name-only crash cleanup requires our lock, even with --force.
    if (locked) {
      await this.removeNamed(templateName(key), signal);
    }
    await this.store.remove(key);
  }
  private async keys(options: TemplateCleanupOptions): Promise<SimulatorTemplateKey[]> {
    if (options.key) {
      return [options.key];
    }
    const manifests = await this.store.list();
    const keys: SimulatorTemplateKey[] = [];
    for (const manifest of manifests) {
      if (options.runtime && manifest.key.runtime !== options.runtime) {
        continue;
      }
      if (options.stale && !(await this.isStale?.(manifest))) {
        continue;
      }
      keys.push(manifest.key);
    }
    return keys;
  }
  private async removeNamed(name: string, signal?: AbortSignal): Promise<void> {
    const list = await this.client.listSimulators(undefined, signal);
    for (const sim of Object.values(list.devices).flat()) {
      if (sim.name === name) {
        await this.client.deleteSimulator(sim.udid, { signal });
      }
    }
  }
  private async removeOrphans(
    handled: Set<string>,
    options: TemplateCleanupOptions,
    refused: string[],
  ): Promise<void> {
    const list = await this.client.listSimulators(undefined, options.signal);
    for (const sim of Object.values(list.devices).flat()) {
      if (!isTemplateSimName(sim.name)) {
        if (sim.name.startsWith("automobile-template-")) {
          logger.warn(`Skipping unrecognized template name ${sim.name}`);
        }
        continue;
      }
      if (handled.has(sim.name)) {
        continue;
      }
      handled.add(sim.name);
      const release = await this.lock.acquireName(sim.name, options.signal);
      if (!release) {
        refused.push(sim.name);
        continue;
      }
      try {
        await this.removeNamed(sim.name, options.signal);
      } finally {
        release();
      }
    }
  }
}
