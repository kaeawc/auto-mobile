import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileHostBootAdmissionRegistry } from "../../src/features/bootAdmission/FileHostBootAdmissionRegistry";
import {
  FakeHostBootAdmissionRegistry,
  SharedBootAdmissionHostState,
} from "../fakes/FakeHostBootAdmissionRegistry";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";
import { FakeTimer } from "../fakes/FakeTimer";
import { runHostBootAdmissionRegistryContract } from "./HostBootAdmissionRegistryContract";

runHostBootAdmissionRegistryContract("FakeHostBootAdmissionRegistry", async () => {
  const host = new SharedBootAdmissionHostState();
  const timer = new FakeTimer();
  return {
    timer,
    open: (pid) => {
      host.exitedPids.delete(pid);
      return new FakeHostBootAdmissionRegistry(host, pid, timer);
    },
    setRunning: (pid, running) => {
      if (running) {
        host.exitedPids.delete(pid);
      } else {
        host.exitedPids.add(pid);
      }
    },
  };
});

// Real side: the file-backed registry over a private mkdtemp directory, one registry per
// simulated daemon pid, with liveness, time and ids injected (#11868).
runHostBootAdmissionRegistryContract("FileHostBootAdmissionRegistry (temp directory)", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "am-boot-admission-contract-"));
  const timer = new FakeTimer();
  const running = new Set<number>();
  const ids = new FakeIdGenerator();
  const ownerGeneration = new FakeLockOwnerGenerationProbe();
  return {
    timer,
    open: (pid) => {
      running.add(pid);
      return new FileHostBootAdmissionRegistry({
        directory: () => directory,
        pid,
        timer,
        isProcessRunning: (candidate) => running.has(candidate),
        readProcessGenerationToken: () => undefined,
        ownerGeneration,
        idGenerator: ids,
      });
    },
    setRunning: (pid, isRunning) => {
      if (isRunning) {
        running.add(pid);
      } else {
        running.delete(pid);
      }
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
});
