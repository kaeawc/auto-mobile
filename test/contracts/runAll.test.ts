import { afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultChecksumCalculator } from "../../src/utils/ChecksumCalculator";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { DefaultProcessExecutor } from "../../src/utils/ProcessExecutor";
import { SystemTimer } from "../../src/utils/SystemTimer";
import { DefaultFileSystem } from "../../src/utils/filesystem/DefaultFileSystem";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";
import { FakeFileSystem } from "../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { runChecksumCalculatorContract } from "./ChecksumCalculatorContract";
import {
  runHostCommandExecutorContract,
  runProcessExecutorContract
} from "./CommandExecutorContract";
import { runFileDownloaderContract } from "./FileDownloaderContract";
import { runFileSystemContract } from "./FileSystemContract";
import { runTimerContract } from "./TimerContract";

runTimerContract("SystemTimer", () => new SystemTimer(), { realTime: true });
runTimerContract("FakeTimer auto-advance", () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
});

const realFileSystemRoot = await fs.mkdtemp(path.join(os.tmpdir(), "automobile-fs-contract-"));
afterAll(async function() {
  await fs.rm(realFileSystemRoot, { recursive: true, force: true });
});
runFileSystemContract("DefaultFileSystem", () => new DefaultFileSystem(), {
  root: realFileSystemRoot
});
runFileSystemContract("FakeFileSystem", () => new FakeFileSystem(), {
  root: "/fake-root"
});

runChecksumCalculatorContract("DefaultChecksumCalculator", {
  make: () => new DefaultChecksumCalculator()
});
runChecksumCalculatorContract("FakeChecksumCalculator", {
  make: expectedChecksum => {
    const calculator = new FakeChecksumCalculator();
    calculator.checksum = expectedChecksum;
    return calculator;
  }
});

runFileDownloaderContract("DefaultFileDownloader", () => new DefaultFileDownloader());
runFileDownloaderContract("FakeFileDownloader", payload => {
  const downloader = new FakeFileDownloader();
  downloader.payload = payload;
  return downloader;
});

runProcessExecutorContract("DefaultProcessExecutor", {
  make: () => new DefaultProcessExecutor(),
  command: "echo contract-output"
});
runProcessExecutorContract("FakeProcessExecutor", {
  make: () => {
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse({
      stdout: "contract-output",
      stderr: "",
      toString() { return this.stdout; },
      trim() { return this.stdout.trim(); },
      includes(searchString: string) { return this.stdout.includes(searchString); }
    });
    return executor;
  },
  command: "contract-command"
});

runHostCommandExecutorContract("DefaultHostCommandExecutor", {
  make: () => new DefaultHostCommandExecutor(),
  file: process.execPath,
  args: ["-e", "process.stdout.write('contract-output')"]
});
runHostCommandExecutorContract("FakeHostCommandExecutor", {
  make: () => {
    const executor = new FakeHostCommandExecutor();
    executor.setDefaultResponse({
      stdout: "contract-output",
      stderr: "",
      toString() { return this.stdout; },
      trim() { return this.stdout.trim(); },
      includes(searchString: string) { return this.stdout.includes(searchString); }
    });
    return executor;
  },
  file: "contract-command",
  args: []
});
