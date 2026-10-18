import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DefaultStartupFailureTracker,
  FileStartupFailureStore,
} from "../../src/daemon/DaemonStartupFailureTracker";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { runStartupFailureTrackerContract } from "./StartupFailureTrackerContract";

runStartupFailureTrackerContract("FakeStartupFailureTracker", async () => ({
  tracker: new FakeStartupFailureTracker(),
}));

// Real side: the file-backed tracker over a private mkdtemp directory (#11868).
runStartupFailureTrackerContract("DefaultStartupFailureTracker (temp file)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "am-startup-failure-contract-"));
  return {
    tracker: new DefaultStartupFailureTracker(
      new FileStartupFailureStore(path.join(dir, "failures.json")),
    ),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
});
