import { z } from "zod/v3";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

/**
 * Host registry of the disposable prototype apps the MCP installed (#14184), keyed by device id.
 * A corrupt file or entry is skipped with a warning, never fatal: the device's package list is the
 * other half of `listApps`, so a lost entry still shows up there.
 */

const recordSchema = z
  .object({
    appId: z.string().min(1),
    slug: z.string().min(1),
    platform: z.enum(["android", "ios"]),
    label: z.string(),
    specSha256: z.string().regex(/^[0-9a-f]{64}$/),
    template: z.string().min(1),
    /** Signing certificate digest (Android) or signing identity (iOS) of the stamped app. */
    signer: z.string().min(1),
    installedAt: z.number().finite(),
    /** Epoch ms after which the app is swept; null keeps it until uninstalled. */
    expiresAt: z.number().finite().nullable(),
  })
  .strict();

export type DisposableAppRecord = z.infer<typeof recordSchema>;

export interface DisposableAppRegistry {
  list(deviceId: string): Promise<DisposableAppRecord[]>;
  /** Insert or replace the record with the same appId on the device. */
  put(deviceId: string, record: DisposableAppRecord): Promise<void>;
  remove(deviceId: string, appId: string): Promise<void>;
}

/** Raw storage for the registry document. `read` resolves undefined when nothing is stored. */
export interface DisposableAppRegistryStore {
  read(): Promise<string | undefined>;
  write(contents: string): Promise<void>;
}

type Devices = Record<string, Record<string, DisposableAppRecord>>;

const REGISTRY_VERSION = 1;

function parseDevices(contents: string | undefined): Devices {
  if (contents === undefined) {
    return {};
  }
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch (error) {
    logger.warn(`Disposable app registry is not valid JSON; ignoring it: ${errorMessage(error)}`);
    return {};
  }
  const shape = z
    .object({ version: z.literal(REGISTRY_VERSION), devices: z.record(z.string(), z.unknown()) })
    .safeParse(document);
  if (!shape.success) {
    logger.warn("Disposable app registry has an unknown shape or version; ignoring it.");
    return {};
  }
  return Object.fromEntries(
    Object.entries(shape.data.devices).map(([deviceId, apps]) => [
      deviceId,
      parseDeviceApps(deviceId, apps),
    ]),
  );
}

function parseDeviceApps(deviceId: string, apps: unknown): Record<string, DisposableAppRecord> {
  if (typeof apps !== "object" || apps === null || Array.isArray(apps)) {
    logger.warn(`Disposable app registry entry for device ${deviceId} is malformed; skipping it.`);
    return {};
  }
  const valid: Record<string, DisposableAppRecord> = {};
  for (const [appId, value] of Object.entries(apps)) {
    const parsed = recordSchema.safeParse(value);
    if (parsed.success && parsed.data.appId === appId) {
      valid[appId] = parsed.data;
    } else {
      logger.warn(`Disposable app registry record ${appId} on ${deviceId} is malformed; skipping.`);
    }
  }
  return valid;
}

export class FileDisposableAppRegistry implements DisposableAppRegistry {
  // Serializes read-modify-write cycles so concurrent installs cannot drop each other's record.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: DisposableAppRegistryStore) {}

  async list(deviceId: string): Promise<DisposableAppRecord[]> {
    const devices = await this.serialized(async () => parseDevices(await this.store.read()));
    return Object.values(devices[deviceId] ?? {}).sort((a, b) => a.appId.localeCompare(b.appId));
  }

  async put(deviceId: string, record: DisposableAppRecord): Promise<void> {
    await this.update((devices) => {
      devices[deviceId] = { ...devices[deviceId], [record.appId]: recordSchema.parse(record) };
    });
  }

  async remove(deviceId: string, appId: string): Promise<void> {
    await this.update((devices) => {
      const apps = { ...devices[deviceId] };
      delete apps[appId];
      if (Object.keys(apps).length === 0) {
        delete devices[deviceId];
      } else {
        devices[deviceId] = apps;
      }
    });
  }

  private async update(mutate: (devices: Devices) => void): Promise<void> {
    await this.serialized(async () => {
      const devices = parseDevices(await this.store.read());
      mutate(devices);
      await this.store.write(
        `${JSON.stringify({ version: REGISTRY_VERSION, devices }, null, 2)}\n`,
      );
    });
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
