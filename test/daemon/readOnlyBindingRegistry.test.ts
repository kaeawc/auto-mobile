import { describe, expect, spyOn, test } from "bun:test";
import { createReadOnlyBindingRegistry } from "../../src/daemon/readOnlyBindingRegistry";
import {
  DeviceOwnershipView,
  createDefaultDeviceOwnershipSources,
} from "../../src/daemon/deviceOwnershipView";
import { openSqliteBindingRegistry } from "../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { logger } from "../../src/utils/logger";
import { assignBindingDevice } from "./sessionBroker/provisioning/bindingFixtures";

describe("createReadOnlyBindingRegistry", () => {
  test("a missing registry file is never opened or created", async () => {
    let opened = false;
    const registry = createReadOnlyBindingRegistry({
      registryPath: () => "/nowhere/bindings.db",
      exists: () => false,
      open: async () => {
        opened = true;
        throw new Error("must not open");
      },
    });
    expect(await registry.findDeviceHolder("android", "Pixel_8")).toBeNull();
    expect(opened).toBe(false);
  });

  test("an unreadable registry logs and reads as no holder", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const registry = createReadOnlyBindingRegistry({
      exists: () => true,
      open: async () => {
        throw new Error("upgrade pending");
      },
    });
    expect(await registry.findDeviceHolder("android", "Pixel_8")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("the exec owner reaches the ownership view and the handle is closed", async () => {
    const real = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    let closed = 0;
    try {
      await assignBindingDevice(real, "android", "Pixel_8", "runner-a", "sess-1");
      const readOnly = createReadOnlyBindingRegistry({
        exists: () => true,
        open: async () => ({
          findDeviceHolder: (p, id) => real.findDeviceHolder(p, id),
          close: async () => {
            closed++;
          },
        }),
      });
      const sources = createDefaultDeviceOwnershipSources({
        registry: readOnly,
        readers: { readLock: () => undefined, isProcessRunning: () => false, listFiles: () => [] },
      });
      const ownership = await new DeviceOwnershipView(sources).ownershipOf({
        platform: "android",
        deviceId: "Pixel_8",
      });
      expect(ownership.records.map((r) => r.source)).toEqual(["exec_owner"]);
      expect(closed).toBe(1);
    } finally {
      await real.close?.();
    }
  });
});
