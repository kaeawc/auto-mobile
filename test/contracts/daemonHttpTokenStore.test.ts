import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeDaemonHttpTokenStore,
  FileDaemonHttpTokenStore,
} from "../../src/daemon/daemonHttpToken";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { runDaemonHttpTokenStoreContract } from "./DaemonHttpTokenStoreContract";

runDaemonHttpTokenStoreContract("in-memory fake", () => {
  const store = new FakeDaemonHttpTokenStore();
  return {
    store,
    replaceToken: (token) => {
      store.token = token;
    },
    dispose: () => {},
  };
});
runDaemonHttpTokenStoreContract("file store in a private directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "am-token-contract-"));
  const path = join(directory, "daemon.token");
  return {
    store: new FileDaemonHttpTokenStore(path, new CountingIdGenerator()),
    replaceToken: (token) => new FileDaemonHttpTokenStore(path).write(token),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
});
