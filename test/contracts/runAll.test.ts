import { afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultChecksumCalculator } from "../../src/utils/ChecksumCalculator";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { CountingIdGenerator, NodeIdGenerator } from "../../src/utils/IdGenerator";
import { CryptoRandom } from "../../src/utils/Random";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { SeededRandom } from "../fakes/SeededRandom";
import { SystemTimer } from "../../src/utils/SystemTimer";
import { DefaultFileSystem } from "../../src/utils/filesystem/DefaultFileSystem";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";
import { FakeFileSystem } from "../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { runChecksumCalculatorContract } from "./ChecksumCalculatorContract";
import { runHostCommandExecutorContract } from "./CommandExecutorContract";
import { runFileDownloaderContract } from "./FileDownloaderContract";
import { runFileSystemContract } from "./FileSystemContract";
import { runIdGeneratorContract } from "./IdGeneratorContract";
import { runRandomContract } from "./RandomContract";
import { runTimerContract } from "./TimerContract";

runIdGeneratorContract("NodeIdGenerator", () => new NodeIdGenerator());
runIdGeneratorContract("CountingIdGenerator", () => new CountingIdGenerator());
runIdGeneratorContract("FakeIdGenerator", () => new FakeIdGenerator());

runRandomContract("CryptoRandom", () => new CryptoRandom());
runRandomContract("SeededRandom", () => new SeededRandom(42));

runTimerContract("SystemTimer", () => new SystemTimer(), { realTime: true });
runTimerContract("FakeTimer auto-advance", () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
});
runTimerContract("FakeTimer manual advance", () => new FakeTimer(), {
  advance: async (timer, ms) => {
    (timer as FakeTimer).advanceTime(ms);
  },
});

const realFileSystemRoot = await fs.mkdtemp(path.join(os.tmpdir(), "automobile-fs-contract-"));
afterAll(async function () {
  await fs.rm(realFileSystemRoot, { recursive: true, force: true });
});
runFileSystemContract("DefaultFileSystem", () => new DefaultFileSystem(), {
  root: realFileSystemRoot,
});
runFileSystemContract("FakeFileSystem", () => new FakeFileSystem(), {
  root: "/fake-root",
});

runChecksumCalculatorContract("DefaultChecksumCalculator", {
  make: () => new DefaultChecksumCalculator(),
  makeFailure: () => new DefaultChecksumCalculator(),
});
runChecksumCalculatorContract("FakeChecksumCalculator", {
  make: (expectedChecksum) => {
    const calculator = new FakeChecksumCalculator();
    calculator.checksum = expectedChecksum;
    return calculator;
  },
  makeFailure: () => {
    const calculator = new FakeChecksumCalculator();
    calculator.shouldThrow = new Error("missing contract file");
    return calculator;
  },
});

runFileDownloaderContract("DefaultFileDownloader", () => new DefaultFileDownloader());
runFileDownloaderContract("FakeFileDownloader", (payload) => {
  const downloader = new FakeFileDownloader();
  downloader.payload = payload;
  return downloader;
});

const REAL_SUBPROCESS_CONTRACT_TIMEOUT_MS = 30_000;

runHostCommandExecutorContract("DefaultHostCommandExecutor", {
  make: () => new DefaultHostCommandExecutor(),
  file: process.execPath,
  args: ["-e", "process.stdout.write('contract-output')"],
  timeoutMs: REAL_SUBPROCESS_CONTRACT_TIMEOUT_MS,
});
runHostCommandExecutorContract("FakeHostCommandExecutor", {
  make: () => {
    const executor = new FakeHostCommandExecutor();
    executor.setDefaultResponse({
      stdout: "contract-output",
      stderr: "",
      toString() {
        return this.stdout;
      },
      trim() {
        return this.stdout.trim();
      },
      includes(searchString: string) {
        return this.stdout.includes(searchString);
      },
    });
    return executor;
  },
  file: "contract-command",
  args: [],
});
