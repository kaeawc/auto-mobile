import type { BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  PROTOTYPE_SAVED_CAPABILITY,
  type PrototypeResult,
} from "../observe/android/ctrlProxyProtocol";
import type { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import type { PrototypeAssetUpload } from "./prototypeAssets";
import type { PrototypeSpec } from "./prototypeSpec";
import {
  missingOnDevice,
  type MirroredSavedPrototype,
  type SavedPrototypeMirror,
} from "./savedPrototypeMirror";

export interface SavedPrototypeRestoreDevice {
  putAsset(upload: PrototypeAssetUpload): Promise<SavedPrototypeRestoreResult>;
  save(save: {
    spec: PrototypeSpec;
    label: string;
    icon?: string;
  }): Promise<SavedPrototypeRestoreResult>;
  list(): Promise<SavedPrototypeRestoreResult>;
}
export type SavedPrototypeRestoreResult = Omit<PrototypeResult, "errorCode"> & {
  errorCode?: string;
};
export interface SavedPrototypeRestoreReport {
  restored: string[];
  skipped: string[];
  failed: { id: string; code: string; reason: string }[];
}
function failedReply(
  reply: SavedPrototypeRestoreResult,
): { code: string; reason: string } | undefined {
  return reply.success && !reply.error
    ? undefined
    : {
        code: reply.errorCode ?? "restore_failed",
        reason: reply.error ?? "Device refused saved prototype restore",
      };
}
async function restoreEntry(
  entry: MirroredSavedPrototype,
  device: SavedPrototypeRestoreDevice,
): Promise<{ code: string; reason: string } | undefined> {
  const missing = entry.assets.filter(
    (asset) => asset.bytes === undefined || asset.mimeType === undefined,
  );
  if (missing.length > 0) {
    return {
      code: "asset_unavailable",
      reason: `Missing mirrored assets: ${missing.map((asset) => asset.id).join(", ")}`,
    };
  }
  for (const asset of entry.assets) {
    if (asset.bytes === undefined || asset.mimeType === undefined) {
      continue;
    }
    const failure = failedReply(
      await device.putAsset({ id: asset.id, mimeType: asset.mimeType, bytes: asset.bytes }),
    );
    if (failure) {
      return failure;
    }
  }
  return failedReply(await device.save({ spec: entry.spec, label: entry.label, icon: entry.icon }));
}
async function restoreEntrySafely(
  entry: MirroredSavedPrototype,
  device: SavedPrototypeRestoreDevice,
): Promise<{ code: string; reason: string } | undefined> {
  try {
    return await restoreEntry(entry, device);
  } catch (error) {
    logger.warn(`[PROTOTYPE] Restore failed for ${entry.id}`, error);
    return { code: "restore_failed", reason: errorMessage(error) };
  }
}
export async function restoreSavedPrototypes(
  serial: string,
  mirror: SavedPrototypeMirror,
  device: SavedPrototypeRestoreDevice,
): Promise<SavedPrototypeRestoreReport> {
  const report: SavedPrototypeRestoreReport = { restored: [], skipped: [], failed: [] };
  try {
    const mirrored = await mirror.list(serial);
    if (mirrored.length === 0) {
      return report;
    }
    let present: { id: string }[] = [];
    try {
      const reply = await device.list();
      if (!failedReply(reply)) {
        present = reply.savedPrototypes ?? [];
      } else {
        logger.warn(`[PROTOTYPE] Device saved prototype list failed for ${serial}`, reply);
      }
    } catch (error) {
      logger.warn(`[PROTOTYPE] Device saved prototype list failed for ${serial}`, error);
    }
    const missing = missingOnDevice(mirrored, present);
    const missingIds = new Set(missing.map((entry) => entry.id));
    report.skipped = mirrored.filter((entry) => !missingIds.has(entry.id)).map((entry) => entry.id);
    for (const entry of missing) {
      const failure = await restoreEntrySafely(entry, device);
      if (failure) {
        report.failed.push({ id: entry.id, ...failure });
        logger.warn(`[PROTOTYPE] Restore failed for ${entry.id}`, failure);
      } else {
        report.restored.push(entry.id);
      }
    }
  } catch (error) {
    logger.warn(`[PROTOTYPE] Saved prototype restore failed for ${serial}`, error);
    report.failed.push({ id: "*", code: "restore_failed", reason: errorMessage(error) });
  }
  return report;
}

export type SavedPrototypeRestoreClient = Pick<
  AndroidCtrlProxyClient,
  | "ensureConnected"
  | "getSupportedCommands"
  | "requestPutPrototypeAsset"
  | "requestSavePrototype"
  | "requestListSavedPrototypes"
>;
/** Dynamic resolution avoids the client -> manager -> restorer -> client import cycle. */
export class AndroidSavedPrototypeRestoreDevice implements SavedPrototypeRestoreDevice {
  private ready: Promise<SavedPrototypeRestoreClient | undefined> | undefined;
  constructor(
    private readonly device: BootedDevice,
    private readonly timer: Timer = defaultTimer,
    private readonly resolveClient: () => Promise<SavedPrototypeRestoreClient> = async () => {
      const { AndroidCtrlProxyClient } = await import("../observe/android/AndroidCtrlProxyClient");
      return (
        AndroidCtrlProxyClient.getExistingInstance(device.deviceId) ??
        AndroidCtrlProxyClient.getInstance(device)
      );
    },
    private readonly timeoutMs = 5000,
  ) {}
  private client(): Promise<SavedPrototypeRestoreClient | undefined> {
    return (this.ready ??= raceWithDeadline(
      async () => {
        const client = await this.resolveClient();
        if (!(await client.ensureConnected())) {
          return undefined;
        }
        return (await client.getSupportedCommands())?.includes(PROTOTYPE_SAVED_CAPABILITY)
          ? client
          : undefined;
      },
      { timer: this.timer, timeoutMs: this.timeoutMs, label: "Saved prototype restore connection" },
    ));
  }
  private unsupported(): SavedPrototypeRestoreResult {
    return {
      success: false,
      errorCode: "device_unsupported",
      error: `Device does not advertise ${PROTOTYPE_SAVED_CAPABILITY}`,
    };
  }
  async list(): Promise<SavedPrototypeRestoreResult> {
    const client = await this.client();
    return client ? client.requestListSavedPrototypes() : this.unsupported();
  }
  async putAsset(upload: PrototypeAssetUpload): Promise<SavedPrototypeRestoreResult> {
    const client = await this.client();
    return client ? client.requestPutPrototypeAsset(upload) : this.unsupported();
  }
  async save(save: {
    spec: PrototypeSpec;
    label: string;
    icon?: string;
  }): Promise<SavedPrototypeRestoreResult> {
    const client = await this.client();
    return client ? client.requestSavePrototype(save) : this.unsupported();
  }
}
