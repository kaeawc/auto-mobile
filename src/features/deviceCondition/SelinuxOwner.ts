import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createSerializer, shell } from "./injectorSupport";

/** Shared by a device's fixtures: the first baseline survives until the last release. */
export class SelinuxOwner {
  private baseline = false;
  private readonly requests = new Map<object, boolean | undefined>();
  private readonly serialize = createSerializer();

  capture(adb: AdbExecutor, token: object, signal?: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      if (this.requests.has(token)) {
        return;
      }
      if (this.requests.size === 0) {
        this.baseline = /permissive/i.test(await shell(adb, ["getenforce"], signal));
      }
      this.requests.set(token, undefined);
    });
  }

  has(token: object): boolean {
    return this.requests.has(token);
  }

  changed(token: object): boolean {
    return this.requests.get(token) !== undefined;
  }

  get owned(): boolean {
    return this.requests.size > 0;
  }

  get expected(): boolean {
    return (
      [...this.requests.values()].filter((value) => value !== undefined).at(-1) ?? this.baseline
    );
  }

  set(adb: AdbExecutor, token: object, target: boolean, signal?: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      // Ownership precedes the write, which can change the device before throwing.
      this.requests.set(token, target);
      await shell(adb, ["setenforce", target ? "0" : "1"], signal);
    });
  }

  release(adb: AdbExecutor, token: object, signal?: AbortSignal, verify = false): Promise<void> {
    return this.serialize(async () => {
      if (!this.requests.has(token)) {
        return;
      }
      const remaining = [...this.requests].filter(
        ([key, value]) => key !== token && value !== undefined,
      );
      const target = remaining.at(-1)?.[1] ?? this.baseline;
      if (this.requests.get(token) !== undefined) {
        await shell(adb, ["setenforce", target ? "0" : "1"], signal);
        if (verify && /permissive/i.test(await shell(adb, ["getenforce"], signal)) !== target) {
          throw new ActionableError("integrityState reset did not restore SELinux read-back");
        }
      }
      this.requests.delete(token);
    });
  }

  async isClean(adb: AdbExecutor, signal?: AbortSignal): Promise<boolean> {
    return /permissive/i.test(await shell(adb, ["getenforce"], signal)) === this.expected;
  }
}

export const selinuxOwnersByDevice = new Map<string, SelinuxOwner>();

export function resolveSelinuxOwner(
  deviceId: string,
  owners: Map<string, SelinuxOwner> = selinuxOwnersByDevice,
): SelinuxOwner {
  let owner = owners.get(deviceId);
  if (!owner) {
    owner = new SelinuxOwner();
    owners.set(deviceId, owner);
  }
  return owner;
}
