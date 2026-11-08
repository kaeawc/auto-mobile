import { Mutex } from "async-mutex";

const locks = new Map<string, Mutex>();

/**
 * The lock every `uiautomator dump` on one device holds: Android accepts one UiAutomation
 * connection at a time, so a second overlapping dump fails. Keyed by device id, not by adb
 * client, because each capture builds its own client.
 */
export function uiautomatorDumpLock(deviceId: string): Mutex {
  let lock = locks.get(deviceId);
  if (!lock) {
    lock = new Mutex();
    locks.set(deviceId, lock);
  }
  return lock;
}
