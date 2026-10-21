import { SimCtlSimulatorDeviceTypeProfiles } from "../../../src/utils/ios-cmdline-tools/SimulatorDeviceTypeProfiles";

import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { FileSimulatorProfileStore } from "../../../src/utils/ios-cmdline-tools/SimulatorProfileStore";
import { resolveAutoMobileBaseDir } from "../../../src/utils/tempDir";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { useScratchRoot } from "../../helpers/scratchRoot";

describe("FileSimulatorProfileStore filesystem boundary", () => {
  const scratch = useScratchRoot("simulator-profile-store-");

  async function fixture() {
    const root = scratch.next();
    const app = path.join(root, "Selected Xcode.app");
    const developer = path.join(app, "Contents/Developer");
    await mkdir(developer, { recursive: true });
    const version = path.join(app, "Contents/version.plist");
    await writeFile(version, "version-one");
    const env = { AUTOMOBILE_DATA_DIR: path.join(root, "daemon-data"), DEVELOPER_DIR: app };
    const store = new FileSimulatorProfileStore(
      () => resolveAutoMobileBaseDir(env),
      env,
      new CountingIdGenerator(),
    );
    return { store, env, version, developer };
  }

  async function populate(store: FileSimulatorProfileStore): Promise<void> {
    const profiles = new SimCtlSimulatorDeviceTypeProfiles(
      {
        getDeviceTypes: async () => [
          {
            identifier: "phone",
            name: "Phone",
            productFamily: "iPhone",
            bundlePath: "/profile",
            minRuntimeVersion: 0,
            maxRuntimeVersion: 0,
          },
        ],
      },
      {
        readJsonFile: async () => ({ mainScreenWidth: 1206 }),
        readJsonBytes: async () => ({}),
        readXmlFile: async () => "",
        readXmlBytes: async () => "",
        extractRawFile: async () => "",
      },
      store,
    );
    await profiles.profileFor("phone");
    await profiles.flushPersistence();
    expect(JSON.parse(await store.read()).profiles[0].pixelWidth).toBe(1206);
  }

  test("cheap stat key follows DEVELOPER_DIR, version changes and Xcode selection", async () => {
    const r = await fixture();
    await populate(r.store);
    const initial = await r.store.currentKey();
    expect(await r.store.currentKey()).toBe(initial);
    // The Xcode.app shorthand and its developer dir identify the same selection.
    r.env.DEVELOPER_DIR = r.developer;
    expect(await r.store.currentKey()).toBe(initial);
    await writeFile(r.version, "version-two-with-different-size");
    const updated = await r.store.currentKey();
    expect(updated).not.toBe(initial);
    await utimes(r.version, new Date(1000), new Date(1000));
    expect(await r.store.currentKey()).not.toBe(updated);
    const other = await fixture();
    expect(await other.store.currentKey()).not.toBe(await r.store.currentKey());
  });

  test("atomic replacement honors the daemon data dir and leaves no temporary files", async () => {
    const r = await fixture();
    await populate(r.store);
    await r.store.write("first complete snapshot");
    expect(await r.store.read()).toBe("first complete snapshot");
    await r.store.write("second complete snapshot");
    expect(
      await readFile(
        path.join(r.env.AUTOMOBILE_DATA_DIR, "simulator-device-type-profiles.json"),
        "utf8",
      ),
    ).toBe("second complete snapshot");
    expect(await readdir(r.env.AUTOMOBILE_DATA_DIR)).toEqual([
      "simulator-device-type-profiles.json",
    ]);
  });
});
