import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DeviceSnapshotStore } from "../../src/utils/DeviceSnapshotStore";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { runDeviceSnapshotStoreContract } from "./DeviceSnapshotStoreContract";

// The real store runs over a private mkdtemp directory removed afterwards; nothing else on the
// host is read or written (#11868).
runDeviceSnapshotStoreContract("FakeDeviceSnapshotStore", async () => {
  const store = new FakeDeviceSnapshotStore("/fake-snapshots");
  return {
    store,
    // Existence comes from replaceSnapshotData; only the scripted size needs setting.
    materialize: async (name, options, bytes) => {
      store.setSnapshotSize(name, bytes, options);
    },
  };
});

runDeviceSnapshotStoreContract("DeviceSnapshotStore (temp directory)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "am-snapshot-store-contract-"));
  const store = new DeviceSnapshotStore(root);
  return {
    store,
    materialize: async (name, options, bytes) => {
      const directory = store.getSnapshotPathWithOptions(name, options);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "payload.bin"), Buffer.alloc(bytes));
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});
