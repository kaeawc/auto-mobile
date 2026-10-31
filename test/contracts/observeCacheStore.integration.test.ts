import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystemObserveCacheStore } from "../../src/features/observe/cache/FileSystemObserveCacheStore";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { runObserveCacheStoreContract } from "./ObserveCacheStoreContract";

// The real store writes only inside a private mkdtemp directory removed afterwards (#11868).
runObserveCacheStoreContract("FakeObserveCacheStore", async (timer) => ({
  store: new FakeObserveCacheStore(timer),
}));

runObserveCacheStoreContract("FileSystemObserveCacheStore (temp directory)", async (timer) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "am-observe-cache-contract-"));
  return {
    store: new FileSystemObserveCacheStore(timer, root, undefined, {
      idGenerator: new CountingIdGenerator("contract"),
    }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});
