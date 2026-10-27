import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  consumeDaemonExitRecord,
  daemonExitRecordPath,
  DaemonSelfExitRecorder,
  DAEMON_EXIT_RECORD_TTL_MS,
  removeDaemonExitRecord,
  resolveDaemonExitOptions,
  writeDaemonExitRecord,
  type DaemonExitRecord,
} from "../../src/daemon/daemonExitRecord";
import type { DaemonOptions, DaemonStatus } from "../../src/daemon/types";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { logger } from "../../src/utils/logger";
import type { DaemonProcessRecord } from "../../src/daemon/processTable";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDaemonExitRecordFileSystem, SafeDaemonManager } from "../fakes/SafeDaemonManager";

const SOCKET = "/memory/daemon.sock";
const OPTIONS: DaemonOptions = {
  port: 3161,
  strictPort: true,
  debug: true,
  debugPerf: true,
  planExecutionLockScope: "global",
  embeddedSdk: true,
  networkMockable: true,
  noUiPerfMode: false,
  host: "127.0.0.1",
  enabledTools: ["tapOn"],
  disabledTools: ["swipeOn"],
  eventAllMarkers: [],
  eventAllMarkersCliOverride: true,
  runnerReadinessTimeoutMs: 4000,
  toolOutputsDir: "/memory/outputs",
  videoFps: 24,
  noOcclusion: true,
  actionsNoObserve: false,
};
function record(options: DaemonOptions = OPTIONS): DaemonExitRecord {
  return { reason: "database-health", exitedAtMs: 0, buildId: "build-a", options };
}

/** Re-exposes the protected recovery steps as public so `spyOn` can stub them without a cast. */
class SpyableManager extends SafeDaemonManager {
  override verifyDaemonGenerationBeforeSignal(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    context?: string,
  ): Promise<boolean> {
    return super.verifyDaemonGenerationBeforeSignal(expected, recoveryDeadline, context);
  }

  override stopNamespaceOrphansForExplicitRestart(recordedPid?: number): Promise<void> {
    return super.stopNamespaceOrphansForExplicitRestart(recordedPid);
  }

  override recordedStatus(): DaemonStatus {
    return super.recordedStatus();
  }

  override removeConfirmedDeadPidFile(): Promise<void> {
    return super.removeConfirmedDeadPidFile();
  }
}

function manager(files: FakeDaemonExitRecordFileSystem, timer = new FakeTimer()) {
  const instance = new SpyableManager({
    timer,
    socketPath: SOCKET,
    identityRecoveryIO: {
      socketExists: () => false,
      readRecord: () => null,
      probe: async () => ({ running: false }),
    },
  });
  const internals = instance.getInternalsForTesting();
  internals.seams.exitRecordFileSystem = files;
  internals.seams.currentBuildId = () => "build-a";
  internals.seams.portFreeProbe = async () => true;
  return { instance, internals };
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});

const FLAGLESS_CLIENT: DaemonOptions = {
  observeResultIncludeElements: false,
  actionsDiffObserve: false,
  actionsNoObserve: false,
};

function launchingManager(files: FakeDaemonExitRecordFileSystem) {
  const timer = new FakeTimer();
  const h = manager(files, timer);
  const previousLogSink = process.env.AUTOMOBILE_LOG_SINK;
  process.env.AUTOMOBILE_LOG_SINK = "stderr";
  restores.push(() => {
    timer.reset();
    if (previousLogSink === undefined) {
      delete process.env.AUTOMOBILE_LOG_SINK;
    } else {
      process.env.AUTOMOBILE_LOG_SINK = previousLogSink;
    }
  });
  h.internals.seams.launchLogFileSystem = { openSync: () => 42, closeSync: () => {} };
  h.internals.seams.launchWorkingDirectory = () => "/memory";
  const status = spyOn(h.instance, "status").mockResolvedValue({ running: false });
  const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
  for (const spy of [
    status,
    stderr,
    spyOn(h.instance, "acquireLock").mockReturnValue(true),
    spyOn(h.instance, "releaseLock").mockImplementation(() => {}),
    spyOn(h.instance, "waitForReady").mockResolvedValue(true),
    spyOn(h.instance, "verifyDaemonGenerationBeforeSignal").mockResolvedValue(true),
  ]) {
    restores.push(() => spy.mockRestore());
  }
  return { ...h, status, stderr, timer };
}

describe("daemon exit record", () => {
  test("full options round-trip once and are consumed", () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record(), files);
    expect(consumeDaemonExitRecord(SOCKET, files)).toEqual(record());
    expect(files.files.size).toBe(0);
    expect(consumeDaemonExitRecord(SOCKET, files)).toBeUndefined();
  });

  test("legacy and malformed records are ignored and removed", () => {
    const files = new FakeDaemonExitRecordFileSystem();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(() => warn.mockRestore());
    for (const raw of [
      JSON.stringify({ port: 3161, exitedAtMs: 0 }),
      "{",
      JSON.stringify({ ...record(), options: { debug: "true" } }),
      JSON.stringify({ ...record(), options: null }),
      JSON.stringify({ ...record(), reason: "bogus" }),
      JSON.stringify({ ...record(), buildId: 1 }),
    ]) {
      files.files.set(daemonExitRecordPath(SOCKET), raw);
      expect(consumeDaemonExitRecord(SOCKET, files)).toBeUndefined();
      expect(files.files.size).toBe(0);
    }
  });

  test("a client auto-start after database-health exit inherits the full startup policy", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record(), files);
    expect(await manager(files).internals.inheritExitSettings({})).toEqual(OPTIONS);
    expect(files.files.size).toBe(0);
  });

  test("inheritance reports reason, port and compact flags on one line without absolute paths", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    const write = spyOn(process.stderr, "write").mockReturnValue(true);
    restores.push(() => write.mockRestore());
    writeDaemonExitRecord(
      SOCKET,
      record({ port: 3161, strictPort: false, debug: true, toolOutputsDir: "/memory/my\noutputs" }),
      files,
    );
    await manager(files).internals.inheritExitSettings({});
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      'Inheriting daemon port 3161 after database-health; flags: strictPort debug toolOutputsDir="my\\noutputs"\n',
    );
  });

  test("defined client values win while undefined and false boolean keys inherit", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record({ ...OPTIONS, embeddedSdk: false }), files);
    expect(
      await manager(files).internals.inheritExitSettings({
        debug: undefined,
        embeddedSdk: true,
        planExecutionLockScope: "session",
        networkMockable: false,
      }),
    ).toEqual({
      ...OPTIONS,
      embeddedSdk: true,
      planExecutionLockScope: "session",
      networkMockable: true,
    });
  });

  test("a flag-less real client's false output flags retain inherited true values", () => {
    const options = {
      observeResultIncludeElements: true,
      actionsDiffObserve: true,
      actionsNoObserve: true,
    };
    expect(
      resolveDaemonExitOptions(FLAGLESS_CLIENT, record(options), 0, 100, "build-a").options,
    ).toEqual(options);
    expect(resolveDaemonExitOptions(FLAGLESS_CLIENT, undefined, 0, 100, "build-a").options).toEqual(
      FLAGLESS_CLIENT,
    );
  });

  test("start sends inherited port and boolean flags to the fake spawner", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(
      SOCKET,
      record({ port: 3161, debug: true, actionsDiffObserve: true }),
      files,
    );
    const h = launchingManager(files);
    expect(await h.instance.start(FLAGLESS_CLIENT)).toBe("started");
    expect(h.instance.defaultSpawner.calls).toHaveLength(1);
    expect(h.instance.defaultSpawner.calls[0]?.args).toEqual(
      expect.arrayContaining([
        "--port",
        "3161",
        "--strict-port",
        "--debug",
        "--actions-diff-observe",
      ]),
    );
    expect(files.files.size).toBe(0);
  });

  test("a joined start leaves the record for the following launching start", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    const entry = record({ port: 3161, debug: true, actionsDiffObserve: true });
    writeDaemonExitRecord(SOCKET, entry, files);
    const h = launchingManager(files);
    h.status.mockResolvedValueOnce({
      running: true,
      pid: 123,
      port: 3161,
      version: DAEMON_VERSION,
    });
    expect(await h.instance.start(FLAGLESS_CLIENT)).toBe("joined");
    expect(files.files.get(daemonExitRecordPath(SOCKET))).toBe(JSON.stringify(entry));
    expect(h.instance.defaultSpawner.calls).toHaveLength(0);
    expect(h.stderr.mock.calls.some(([line]) => String(line).includes("Inheriting"))).toBe(false);
    expect(await h.instance.start(FLAGLESS_CLIENT)).toBe("started");
    expect(h.instance.defaultSpawner.calls[0]?.args).toEqual(
      expect.arrayContaining([
        "--port",
        "3161",
        "--strict-port",
        "--debug",
        "--actions-diff-observe",
      ]),
    );
    expect(files.files.size).toBe(0);
  });

  function prepareRunningReplacement(h: ReturnType<typeof launchingManager>) {
    h.timer.enableAutoAdvance();
    for (const spy of [
      spyOn(h.instance, "prepareDaemonForConditionalRestart").mockResolvedValue({
        accepted: true,
      }),
      spyOn(h.instance, "stopRunningDaemon").mockResolvedValue(undefined),
      spyOn(h.instance, "assertNoSurvivingDaemonBeforeRestart").mockResolvedValue(undefined),
      spyOn(h.instance, "stopNamespaceOrphansForExplicitRestart").mockResolvedValue(undefined),
      spyOn(h.instance, "recordedStatus").mockReturnValue({ running: false }),
    ]) {
      restores.push(() => spy.mockRestore());
    }
  }

  test("an older running daemon takeover discards the record and preserves running options", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record({ port: 3161, debug: true, embeddedSdk: true }), files);
    const h = launchingManager(files);
    prepareRunningReplacement(h);
    h.status.mockResolvedValueOnce({
      running: true,
      pid: 123,
      version: "0.0.0",
      options: { port: 4000, debug: false },
    });
    expect(await h.instance.start()).toBe("started");
    const args = h.instance.defaultSpawner.calls[0]?.args;
    expect(args).toEqual(expect.arrayContaining(["--port", "4000", "--strict-port"]));
    expect(args).not.toContain("--debug");
    expect(args).not.toContain("--embedded-sdk");
    expect(files.files.size).toBe(0);
    expect(h.stderr.mock.calls.some(([line]) => String(line).includes("Inheriting"))).toBe(false);
  });

  test("restart after stopping a running daemon uses its options without record inheritance", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    const h = launchingManager(files);
    prepareRunningReplacement(h);
    h.status.mockResolvedValueOnce({
      running: true,
      pid: 123,
      port: 4000,
      options: { debug: true },
    });
    const stop = spyOn(h.instance, "stop").mockImplementation(async () => {
      // A record present at launch must not alter this running-generation restart.
      writeDaemonExitRecord(SOCKET, record({ embeddedSdk: true }), files);
    });
    restores.push(() => stop.mockRestore());
    expect(await h.instance.restart({ debug: false })).toBe("restarted");
    const args = h.instance.defaultSpawner.calls[0]?.args;
    expect(args).toEqual(expect.arrayContaining(["--port", "4000", "--strict-port"]));
    expect(args).not.toContain("--debug");
    expect(args).not.toContain("--embedded-sdk");
    expect(files.files.size).toBe(0);
    expect(h.stderr.mock.calls.some(([line]) => String(line).includes("Inheriting"))).toBe(false);
  });

  test("restart after a self-exit inherits the record at the replacement launch", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(
      SOCKET,
      record({ port: 3161, debug: true, actionsDiffObserve: true }),
      files,
    );
    const h = launchingManager(files);
    prepareRunningReplacement(h);
    expect(await h.instance.restart(FLAGLESS_CLIENT)).toBe("restarted");
    expect(h.instance.defaultSpawner.calls[0]?.args).toEqual(
      expect.arrayContaining([
        "--port",
        "3161",
        "--strict-port",
        "--debug",
        "--actions-diff-observe",
      ]),
    );
    expect(files.files.size).toBe(0);
  });

  test("an explicit client port excludes inherited port and strictness but inherits other flags", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record(), files);
    const { internals } = manager(files);
    internals.seams.portFreeProbe = async () => {
      throw new Error("explicit port must not be probed");
    };
    const other = { ...OPTIONS };
    delete other.strictPort;
    expect(await internals.inheritExitSettings({ port: 4000 })).toEqual({ ...other, port: 4000 });
    expect(files.files.size).toBe(0);
    expect(
      resolveDaemonExitOptions(
        { port: 4000, strictPort: false },
        record(),
        0,
        DAEMON_EXIT_RECORD_TTL_MS,
        "build-a",
      ).options.strictPort,
    ).toBeUndefined();
  });

  test("the TTL boundary inherits; one millisecond beyond logs exactly one info", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    const timer = new FakeTimer();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    restores.push(() => info.mockRestore());
    const { internals } = manager(files, timer);
    timer.setCurrentTime(DAEMON_EXIT_RECORD_TTL_MS);
    writeDaemonExitRecord(SOCKET, record(), files);
    expect(await internals.inheritExitSettings({})).toEqual(OPTIONS);
    expect(info).toHaveBeenCalledTimes(0);
    timer.advanceTime(1);
    writeDaemonExitRecord(SOCKET, record(), files);
    expect(await internals.inheritExitSettings({ debug: undefined })).toEqual({});
    expect(info).toHaveBeenCalledTimes(1);
    expect(files.files.size).toBe(0);
  });

  test("different build ids log exactly one info; identical ids inherit", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    restores.push(() => info.mockRestore());
    const { internals } = manager(files);
    writeDaemonExitRecord(SOCKET, { ...record(), buildId: "build-b" }, files);
    expect(await internals.inheritExitSettings({})).toEqual({});
    expect(info).toHaveBeenCalledTimes(1);
    writeDaemonExitRecord(SOCKET, record(), files);
    expect(await internals.inheritExitSettings({})).toEqual(OPTIONS);
    expect(info).toHaveBeenCalledTimes(1);
  });

  test("an unknown option from another build reaches build-mismatch without a malformed warning", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(
      () => info.mockRestore(),
      () => warn.mockRestore(),
    );
    files.files.set(
      daemonExitRecordPath(SOCKET),
      JSON.stringify({
        ...record(),
        buildId: "build-b",
        options: { ...OPTIONS, futureOption: true },
      }),
    );
    expect(await manager(files).internals.inheritExitSettings({})).toEqual({});
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Ignoring daemon exit record: build-mismatch");
    expect(warn).not.toHaveBeenCalled();
    expect(files.files.size).toBe(0);
  });

  test("a client's enabled list removes conflicts from the inherited disabled list", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record({ disabledTools: ["a", "b"] }), files);
    expect(await manager(files).internals.inheritExitSettings({ enabledTools: ["a"] })).toEqual({
      disabledTools: ["b"],
      enabledTools: ["a"],
    });
  });

  test("a client's disabled list removes conflicts from the inherited enabled list", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record({ enabledTools: ["a", "b"] }), files);
    expect(await manager(files).internals.inheritExitSettings({ disabledTools: ["a"] })).toEqual({
      enabledTools: ["b"],
      disabledTools: ["a"],
    });
  });

  test("every daemon process option round-trips and inherits except probed strictness", async () => {
    const options: Omit<
      Required<DaemonOptions>,
      "toolResultsNoStructuredContent" | "actionsCompactMetadata"
    > = {
      port: 3161,
      host: "127.0.0.1",
      strictPort: false,
      debug: true,
      debugPerf: true,
      planExecutionLockScope: "global",
      runnerReadinessTimeoutMs: 4000,
      videoQualityPreset: "high",
      videoTargetBitrateKbps: 1000,
      videoMaxThroughputMbps: 10,
      videoFps: 24,
      videoFormat: "mp4",
      videoMaxArchiveSizeMb: 100,
      toolOutputsDir: "/memory/outputs",
      networkMockable: true,
      embeddedSdk: true,
      enabledTools: ["a"],
      disabledTools: ["b"],
      dismissKeyboardAfterInput: true,
      eventAllMarkers: ["marker"],
      eventAllMarkersCliOverride: true,
      noUiPerfMode: false,
      memPerfAudit: true,
      accessibilityAudit: true,
      accessibilityLevel: "AA",
      accessibilityFailureMode: "warn",
      accessibilityMinSeverity: "minor",
      accessibilityUseBaseline: true,
      predictiveUi: true,
      rawElementSearch: true,
      skipCtrlProxyDownload: true,
      toolCallRecording: true,
      noNavigationScreenshots: true,
      noWaitForPollingOverhead: true,
      noA11yIncludeNotImportantViews: true,
      noA11yReportViewIds: true,
      noA11yRetrieveInteractiveWindows: true,
      noOcclusion: true,
      observeResultIncludeElements: true,
      actionsDiffObserve: true,
      actionsNoObserve: false,
    };
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record(options), files);
    const { internals } = manager(files);
    expect(await internals.inheritExitSettings({})).toEqual({ ...options, strictPort: true });
    expect(files.files.size).toBe(0);
    writeDaemonExitRecord(SOCKET, record(options), files);
    internals.seams.portFreeProbe = async () => false;
    expect(await internals.inheritExitSettings({})).toEqual(options);
    expect(files.files.size).toBe(0);
  });

  test("a busy inherited port is non-strict even when recorded as strict", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record(), files);
    const { internals } = manager(files);
    internals.seams.portFreeProbe = async () => false;
    expect(await internals.inheritExitSettings({})).toEqual({ ...OPTIONS, strictPort: false });
  });

  test("stop without a running daemon clears inheritance", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record(), files);
    const { instance, internals } = manager(files);
    for (const spy of [
      spyOn(instance, "status").mockResolvedValue({ running: false }),
      spyOn(internals.identityRecoveryIO, "socketExists").mockReturnValue(false),
      spyOn(instance, "removeConfirmedDeadPidFile").mockResolvedValue(undefined),
    ]) {
      restores.push(() => spy.mockRestore());
    }
    await instance.stop();
    expect(files.files.size).toBe(0);
    expect(await internals.inheritExitSettings({})).toEqual({});
  });

  test("stop clears the record after stopping a running daemon", async () => {
    const files = new FakeDaemonExitRecordFileSystem();
    writeDaemonExitRecord(SOCKET, record(), files);
    const { instance } = manager(files);
    const stop = spyOn(instance, "stopRunningDaemon").mockImplementation(async () => {
      expect(files.files.size).toBe(1);
    });
    restores.push(() => stop.mockRestore());
    await instance.stop(undefined, { running: true, pid: 123 });
    expect(files.files.size).toBe(0);
  });

  test("pure resolver reports the outcome and port provenance", () => {
    expect(resolveDaemonExitOptions({}, undefined, 0, 100, "build-a")).toEqual({
      options: {},
      outcome: "none",
      inheritedPort: false,
    });
    expect(resolveDaemonExitOptions({}, record(), 0, 100, "build-a")).toEqual({
      options: OPTIONS,
      outcome: "inherited",
      inheritedPort: true,
    });
    expect(
      resolveDaemonExitOptions({ port: 4000 }, record(), 0, 100, "build-a").inheritedPort,
    ).toBe(false);
  });

  test("file writes and removals are best effort", () => {
    const files = new FakeDaemonExitRecordFileSystem();
    files.writeFileSync = () => {
      throw new Error("write failed");
    };
    files.rmSync = () => {
      throw new Error("remove failed");
    };
    expect(() => writeDaemonExitRecord(SOCKET, record(), files)).not.toThrow();
    expect(() => removeDaemonExitRecord(SOCKET, files)).not.toThrow();
  });
});

describe("daemon self-exit recorder", () => {
  function recorder(canRecord = true, write: (entry: DaemonExitRecord) => void = () => {}) {
    const timer = new FakeTimer();
    const entries: DaemonExitRecord[] = [];
    const instance = new DaemonSelfExitRecorder({
      now: () => timer.now(),
      buildId: () => "build-a",
      options: () => OPTIONS,
      canRecord: () => canRecord,
      write: (entry) => {
        entries.push(entry);
        write(entry);
      },
    });
    return { instance, entries, timer };
  }

  test("a clean stop prevents any further record and leaves an existing one alone", () => {
    const clean = recorder();
    clean.instance.markCleanStop();
    clean.instance.record("unexpected-exit");
    expect(clean.entries).toEqual([]);
    const self = recorder();
    self.instance.record("orphan-watchdog");
    self.instance.markCleanStop();
    self.instance.record("unexpected-exit");
    expect(self.entries.map((entry) => entry.reason)).toEqual(["orphan-watchdog"]);
  });

  test("the first synchronous record wins", () => {
    const { instance, entries, timer } = recorder();
    timer.advanceTime(5);
    instance.record("startup-failure");
    timer.advanceTime(1);
    instance.record("unexpected-exit");
    expect(entries).toEqual([{ ...record(), reason: "startup-failure", exitedAtMs: 5 }]);
  });

  test("an unbound refused contender cannot record beside a live incumbent", () => {
    const { instance, entries } = recorder(false);
    instance.record("startup-failure");
    expect(entries).toEqual([]);
  });

  test("an unbound sole contender records startup failure", () => {
    const { instance, entries } = recorder(true);
    instance.record("startup-failure");
    expect(entries).toHaveLength(1);
  });

  test("a throwing writer cannot escape and is not retried by the exit backstop", () => {
    const { instance, entries } = recorder(true, () => {
      throw new Error("write failed");
    });
    expect(() => instance.record("database-health")).not.toThrow();
    instance.record("unexpected-exit");
    expect(entries).toHaveLength(1);
  });
});
