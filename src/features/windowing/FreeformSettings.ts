import { ActionableError } from "../../models/ActionableError";
import {
  FREEFORM_SETTING_KEYS,
  type FreeformSettingKey,
  type WindowSettingsReceipt,
} from "./WindowModeTypes";
import { READ_BOOT_ID, readGlobalSetting, writeGlobalSetting } from "./windowModeCommands";

/** Runs one device-shell command and returns its trimmed stdout. */
export type DeviceShell = (command: string) => Promise<string>;

const BOOT_ID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const SETTING_VALUE = /^\d+$/;

async function readBootId(shell: DeviceShell): Promise<string> {
  const bootId = await shell(READ_BOOT_ID);
  if (!BOOT_ID.test(bootId)) {
    throw new ActionableError("Cannot identify this Android boot; no settings were changed.");
  }
  return bootId;
}

async function readSetting(shell: DeviceShell, key: FreeformSettingKey): Promise<string | null> {
  const value = await shell(readGlobalSetting(key));
  if (value === "null" || value === "") {
    return null;
  }
  if (!SETTING_VALUE.test(value)) {
    throw new ActionableError(`Cannot read global setting ${key}: unexpected value "${value}".`);
  }
  return value;
}

async function writeVerified(
  shell: DeviceShell,
  key: FreeformSettingKey,
  value: string | null,
): Promise<void> {
  await shell(writeGlobalSetting(key, value));
  const after = await readSetting(shell, key);
  if (after !== value) {
    throw new ActionableError(
      `Global setting ${key} read back ${after ?? "null"} after writing ${value ?? "null"}.`,
    );
  }
}

/**
 * Turns on `enable_freeform_support` and `force_resizable_activities` (#14115) and returns the
 * prior values of the ones it changed. Settings already on are left alone and not receipted.
 */
export async function enableFreeformSettings(
  shell: DeviceShell,
  deviceId: string,
): Promise<{ changed: FreeformSettingKey[]; receipt?: WindowSettingsReceipt }> {
  const bootId = await readBootId(shell);
  const entries: WindowSettingsReceipt["entries"] = [];
  for (const key of FREEFORM_SETTING_KEYS) {
    const before = await readSetting(shell, key);
    if (before === "1") {
      continue;
    }
    // Receipt the prior value before writing, so a failed read-back still leaves a way back.
    entries.push({ key, value: before });
    await writeVerified(shell, key, "1");
  }
  return {
    changed: entries.map((entry) => entry.key),
    ...(entries.length ? { receipt: { deviceId, bootId, entries } } : {}),
  };
}

/** Writes back a receipt's prior values, refusing a receipt from another device or boot. */
export async function restoreFreeformSettings(
  shell: DeviceShell,
  deviceId: string,
  receipt: WindowSettingsReceipt,
): Promise<FreeformSettingKey[]> {
  if (receipt.deviceId !== deviceId) {
    throw new ActionableError(
      `This restore receipt belongs to device ${receipt.deviceId}, not ${deviceId}. Nothing was restored.`,
    );
  }
  if ((await readBootId(shell)) !== receipt.bootId) {
    throw new ActionableError(
      "This restore receipt belongs to an earlier boot of this device. Nothing was restored.",
    );
  }
  const invalid = receipt.entries.find(
    (entry) =>
      !FREEFORM_SETTING_KEYS.includes(entry.key) ||
      (entry.value !== null && !SETTING_VALUE.test(entry.value)),
  );
  if (invalid) {
    throw new ActionableError(
      `This restore receipt has an unsupported entry for ${invalid.key}. Nothing was restored.`,
    );
  }
  const restored: FreeformSettingKey[] = [];
  for (const entry of receipt.entries) {
    await writeVerified(shell, entry.key, entry.value);
    restored.push(entry.key);
  }
  return restored;
}
