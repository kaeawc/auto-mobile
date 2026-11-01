import { Mutex } from "async-mutex";

const locks = new Map<string, Mutex>();

/**
 * The lock every pointer run on one device holds, whatever its route: an instrumentation stroke and
 * a uinput pen must never play at once. It is keyed by device id, not by adb client, because each
 * tool call builds its own client.
 */
export function pointerDispatchLock(deviceId: string): Mutex {
  let lock = locks.get(deviceId);
  if (!lock) {
    lock = new Mutex();
    locks.set(deviceId, lock);
  }
  return lock;
}
