import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileNativeHelperRecordStore } from "../../src/utils/nativeHelpers/NativeHelperRecordStore";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeNativeHelperRecordStore } from "../fakes/FakeNativeHelperRecordStore";
import { runNativeHelperRecordStoreContract } from "./NativeHelperRecordStoreContract";

runNativeHelperRecordStoreContract("FakeNativeHelperRecordStore", async () => ({
  store: new FakeNativeHelperRecordStore(),
}));

// The real store resolves its directory from AUTOMOBILE_DATA_DIR; point it at a private
// mkdtemp directory that is removed afterwards (#11868).
runNativeHelperRecordStoreContract("FileNativeHelperRecordStore (temp directory)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "am-native-helper-contract-"));
  const original = process.env.AUTOMOBILE_DATA_DIR;
  process.env.AUTOMOBILE_DATA_DIR = root;
  return {
    store: new FileNativeHelperRecordStore(new FakeLogger()),
    dispose: async () => {
      if (original === undefined) {
        delete process.env.AUTOMOBILE_DATA_DIR;
      } else {
        process.env.AUTOMOBILE_DATA_DIR = original;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
});
