import { afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultChecksumCalculator } from "../../src/utils/ChecksumCalculator";
import { DefaultFileDownloader } from "../../src/utils/FileDownloader";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { SystemTimer } from "../../src/utils/SystemTimer";
import { DefaultFileSystem } from "../../src/utils/filesystem/DefaultFileSystem";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";
import { runChecksumCalculatorContract } from "./ChecksumCalculatorContract";
import { runHostCommandExecutorContract } from "./CommandExecutorContract";
import { runFileDownloaderContract } from "./FileDownloaderContract";
import { runFileSystemContract } from "./FileSystemContract";
import { runTimerContract } from "./TimerContract";

runTimerContract("SystemTimer", () => new SystemTimer(), { realTime: true });

const realFileSystemRoot = await fs.mkdtemp(path.join(os.tmpdir(), "automobile-fs-contract-"));
afterAll(async function () {
  await fs.rm(realFileSystemRoot, { recursive: true, force: true });
});
runFileSystemContract("DefaultFileSystem", () => new DefaultFileSystem(), {
  root: realFileSystemRoot,
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

runHostCommandExecutorContract("DefaultHostCommandExecutor", {
  make: () => new DefaultHostCommandExecutor(),
  file: process.execPath,
  args: ["-e", "process.stdout.write('contract-output')"],
  timeoutMs: 30_000,
});
