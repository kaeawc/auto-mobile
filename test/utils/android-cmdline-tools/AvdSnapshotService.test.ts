import { describe, expect, test } from "bun:test";
import * as path from "path";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  AVD_SNAPSHOTS_DIRNAME,
  FileAvdConfigReader,
  type AvdDirectoryResolver,
} from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import { AvdSnapshotService } from "../../../src/utils/android-cmdline-tools/AvdSnapshotService";
import {
  buildVmSnapshotCommand,
  evaluateVmSnapshotResult,
  isMissingVmSnapshotError,
} from "../../../src/utils/android-cmdline-tools/vmSnapshot";
import type { BootedDevice, ExecResult } from "../../../src/models";

// Every path here is built with `path.join`, exactly as the production code
// does. Hard-coding POSIX separators made this suite a false negative on the
// `windows-latest` leg of the node-unit-tests matrix: production joined with
// backslashes while the fake was keyed on slashes, so `measureVmSnapshotBytes`
// looked up a key that could never match and quietly returned null (#6490
// review).
const AVD_HOME = path.join("/home", "tester", ".android", "avd");

/** `<avdHome>/<avd>.avd` — the conventional AVD directory the resolver returns. */
function avdDirectory(avdName: string): string {
  return path.join(AVD_HOME, `${avdName}.avd`);
}

/** `<avd>.avd/snapshots` — the root AvdSnapshotService measures under. */
function avdSnapshotsRoot(avdName: string): string {
  return path.join(avdDirectory(avdName), AVD_SNAPSHOTS_DIRNAME);
}

/** `<avd>.avd/snapshots/<name>` — the in-AVD payload directory of one snapshot. */
function avdSnapshotPath(avdName: string, snapshotName: string): string {
  return path.join(avdSnapshotsRoot(avdName), snapshotName);
}

class FakeDirectories {
  constructor(
    private readonly sizes: Record<string, number>,
    private readonly children: Record<string, string[]>,
    private readonly files: Record<string, string[]> = {},
  ) {}

  async getDirectorySize(dirPath: string): Promise<number | null> {
    return dirPath in this.sizes ? this.sizes[dirPath] : null;
  }

  async listSubdirectoryNames(dirPath: string): Promise<string[] | null> {
    return this.children[dirPath] ?? null;
  }

  async listFileNames(dirPath: string): Promise<string[] | null> {
    return this.files[dirPath] ?? null;
  }
}

class FakeAvdDirectories implements AvdDirectoryResolver {
  constructor(private readonly known: Set<string>) {}

  getAvdHome(): string {
    return AVD_HOME;
  }

  async resolveAvdDirectory(avdName: string): Promise<string | null> {
    return this.known.has(avdName) ? avdDirectory(avdName) : null;
  }
}

function stubEmulator(devices: BootedDevice[]) {
  return {
    getBootedDevices: async () => devices,
  } as never;
}

function recordingAdbFactory(result: ExecResult | Error) {
  const commands: string[] = [];
  const executeOptions: Array<AdbExecuteOptions | undefined> = [];
  const execute = async (command: string, options?: AdbExecuteOptions): Promise<ExecResult> => {
    executeOptions.push(options);
    await options?.beforeDispatch?.();
    commands.push(command);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  const factory: AdbClientFactory = {
    create: () =>
      ({
        executeCommand: async (command: string) => execute(command),
        execute: async (args: string[], options?: AdbExecuteOptions) =>
          execute(args.join(" "), options),
      }) as never,
  };
  return { factory, commands, executeOptions };
}

function execResult(stdout: string): ExecResult {
  return { stdout, stderr: "" } as ExecResult;
}

describe("vmSnapshot delete command (#6490)", () => {
  test("delete maps to the emulator console's `del` verb", () => {
    expect(buildVmSnapshotCommand("delete", "snap")).toBe("emu avd snapshot del snap");
    expect(buildVmSnapshotCommand("save", "snap")).toBe("emu avd snapshot save snap");
  });

  test("a delete response is judged the same way save/load is", () => {
    expect(evaluateVmSnapshotResult("delete", "snap", execResult("OK")).ok).toBe(true);
    const failure = evaluateVmSnapshotResult("delete", "snap", execResult("KO: bad state"));
    expect(failure.ok).toBe(false);
    expect(failure.errorMessage).toContain("VM snapshot delete failed for 'snap'");
  });

  test("a missing snapshot is recognizable so reclaim can treat it as already done", () => {
    const missing = evaluateVmSnapshotResult(
      "delete",
      "snap",
      execResult("KO: no snapshot named 'snap' does not exist"),
    );
    expect(isMissingVmSnapshotError(missing.errorMessage)).toBe(true);
    expect(isMissingVmSnapshotError("VM snapshot delete failed for 'snap': boom")).toBe(false);
  });
});

describe("AvdSnapshotService (#6490)", () => {
  const service = (
    sizes: Record<string, number>,
    children: Record<string, string[]>,
    known: string[],
    devices: BootedDevice[] = [],
    adb = recordingAdbFactory(execResult("OK")),
    files: Record<string, string[]> = {},
  ) =>
    new AvdSnapshotService(
      new FakeDirectories(sizes, children, files),
      new FakeAvdDirectories(new Set(known)),
      stubEmulator(devices),
      adb.factory,
    );

  test("measures <avd>.avd/snapshots/<name>, and reports null for an unknown AVD", async () => {
    const sut = service({ [avdSnapshotPath("am-api36", "snap")]: 2_100_829_021 }, {}, ["am-api36"]);

    expect(await sut.measureVmSnapshotBytes("am-api36", "snap")).toBe(2_100_829_021);
    expect(await sut.measureVmSnapshotBytes("am-api36", "absent")).toBeNull();
    expect(await sut.measureVmSnapshotBytes("not-an-avd", "snap")).toBeNull();
  });

  test("lists in-AVD snapshot directories exactly as they are on disk", async () => {
    const sut = service(
      {
        [avdSnapshotPath("am-api34", "default_boot")]: 10,
        [avdSnapshotPath("am-api34", "sweepSnap")]: 20,
      },
      { [avdSnapshotsRoot("am-api34")]: ["default_boot", "sweepSnap"] },
      ["am-api34"],
    );

    expect(await sut.listAvdSnapshotDirectories("am-api34")).toEqual([
      {
        snapshotName: "default_boot",
        directoryPath: avdSnapshotPath("am-api34", "default_boot"),
        sizeBytes: 10,
      },
      {
        snapshotName: "sweepSnap",
        directoryPath: avdSnapshotPath("am-api34", "sweepSnap"),
        sizeBytes: 20,
      },
    ]);
  });

  test("a relocated AVD reports where its snapshots ACTUALLY are (#6891 review)", async () => {
    // The documented manual cleanup used to name the conventional
    // `~/.android/avd/<avd>.avd/snapshots/<name>` path. For an AVD moved by
    // ANDROID_AVD_HOME or an `<avd>.ini` redirect that path is not the directory
    // this scanner measured, so following the docs left the reported orphan in
    // place — and operated on some stale directory instead.
    const relocated = path.join("/Volumes", "big-disk", "avds", "am-relocated.avd");
    const snapshotsRoot = path.join(relocated, AVD_SNAPSHOTS_DIRNAME);
    const sut = new AvdSnapshotService(
      new FakeDirectories(
        { [path.join(snapshotsRoot, "sweepSnap")]: 20 },
        { [snapshotsRoot]: ["sweepSnap"] },
      ),
      {
        getAvdHome: () => AVD_HOME,
        resolveAvdDirectory: async (avdName: string) =>
          avdName === "am-relocated" ? relocated : null,
      },
      stubEmulator([]),
      recordingAdbFactory(execResult("OK")).factory,
    );

    expect(await sut.listAvdSnapshotDirectories("am-relocated")).toEqual([
      {
        snapshotName: "sweepSnap",
        directoryPath: path.join(snapshotsRoot, "sweepSnap"),
        sizeBytes: 20,
      },
    ]);
  });

  test("known AVD names come from the `.avd` directories in the AVD home", async () => {
    const sut = service({}, { [AVD_HOME]: ["am-api34.avd", "am-api36.avd", "snapshots"] }, []);

    expect(await sut.listKnownAvdNames()).toEqual(["am-api34", "am-api36"]);
  });

  test("an AVD relocated through `<name>.ini` is still enumerated (#6490 review)", async () => {
    // A relocated AVD leaves only a registry FILE in the AVD home; its `.avd`
    // directory lives elsewhere, so a subdirectory-only scan never sees it and
    // the redirect-aware resolver is never even consulted.
    const sut = service(
      {},
      { [AVD_HOME]: ["am-api34.avd"] },
      [],
      [],
      recordingAdbFactory(execResult("OK")),
      { [AVD_HOME]: ["am-api34.ini", "am-relocated.ini", "hardware-qemu.ini.lock", "README"] },
    );

    expect(await sut.listKnownAvdNames()).toEqual(["am-api34", "am-relocated"]);
  });

  test("a live emulator is found by AVD name, not by serial", async () => {
    const sut = service(
      {},
      {},
      [],
      [
        { deviceId: "emulator-5554", name: "am-api34", platform: "android" },
        { deviceId: "emulator-5556", name: "am-api36", platform: "android" },
      ],
    );

    expect(await sut.findLiveEmulatorSerial("am-api36")).toBe("emulator-5556");
    expect(await sut.findLiveEmulatorSerial("am-api28")).toBeNull();
  });

  test("deleteVmSnapshot issues exactly one console delete and reports the outcome", async () => {
    const adb = recordingAdbFactory(execResult("OK"));
    const sut = service({}, {}, [], [], adb);

    expect(await sut.deleteVmSnapshot("emulator-5556", "snap", 30000)).toEqual({ reclaimed: true });
    expect(adb.commands).toEqual(["emu avd snapshot del snap"]);
    expect(adb.executeOptions).toEqual([
      { timeoutMs: 30000, waitForProcessSettlementAfterAbort: true },
    ]);
  });

  test("deleteVmSnapshot skips the console delete when its serial has been reassigned", async () => {
    const adb = recordingAdbFactory(execResult("OK"));
    const sut = service(
      {},
      {},
      [],
      [{ deviceId: "emulator-5556", name: "am-api34", platform: "android" }],
      adb,
    );

    const outcome = await sut.deleteVmSnapshot("emulator-5556", "snap", 30000, "am-api36");

    expect(outcome.reclaimed).toBe(false);
    expect(outcome.reason).toContain("expected AVD 'am-api36'");
    expect(outcome.reason).toContain("currently hosts 'am-api34'");
    expect(adb.commands).toEqual([]);
  });

  test("deleteVmSnapshot dispatches when its serial still belongs to the expected AVD", async () => {
    const adb = recordingAdbFactory(execResult("OK"));
    const sut = service(
      {},
      {},
      [],
      [{ deviceId: "emulator-5556", name: "am-api36", platform: "android" }],
      adb,
    );

    expect(await sut.deleteVmSnapshot("emulator-5556", "snap", 30000, "am-api36")).toEqual({
      reclaimed: true,
    });
    expect(adb.commands).toEqual(["emu avd snapshot del snap"]);
  });

  test("deleteVmSnapshot stops retries when the serial is reassigned between attempts", async () => {
    const liveDevices = {
      current: [
        { deviceId: "emulator-5556", name: "am-api36", platform: "android" } as BootedDevice,
      ],
    };
    let dispatches = 0;
    const client = new AdbClient(
      { deviceId: "emulator-5556", name: "emulator-5556", platform: "android" },
      async () => {
        dispatches += 1;
        liveDevices.current = [
          { deviceId: "emulator-5556", name: "am-api34", platform: "android" },
        ];
        if (dispatches === 1) {
          throw new Error("adb transient blip");
        }
        return execResult("OK");
      },
      null,
      defaultRetryExecutor,
      new FakeTimer(),
    );
    const adbFactory: AdbClientFactory = { create: () => client };
    const sut = new AvdSnapshotService(
      new FakeDirectories({}, {}),
      new FakeAvdDirectories(new Set()),
      {
        getBootedDevices: async () => liveDevices.current,
      } as never,
      adbFactory,
    );

    expect(await sut.deleteVmSnapshot("emulator-5556", "snap", 30000, "am-api36")).toEqual({
      reclaimed: false,
      reason:
        "Skipping VM snapshot delete for 'snap': serial 'emulator-5556' expected AVD 'am-api36' but currently hosts 'am-api34'",
    });
    expect(dispatches).toBe(1);
  });

  test("a snapshot that is already gone counts as reclaimed", async () => {
    const adb = recordingAdbFactory(execResult("KO: snapshot 'snap' does not exist"));
    const sut = service({}, {}, [], [], adb);

    expect(await sut.deleteVmSnapshot("emulator-5556", "snap", 30000)).toEqual({ reclaimed: true });
  });

  test("a transport failure is reported as not reclaimed, with a reason", async () => {
    const adb = recordingAdbFactory(new Error("device offline"));
    const sut = service({}, {}, [], [], adb);

    const outcome = await sut.deleteVmSnapshot("emulator-5556", "snap", 30000);
    expect(outcome.reclaimed).toBe(false);
    expect(outcome.reason).toContain("VM snapshot delete failed for 'snap'");
  });
});

describe("FileAvdConfigReader.resolveAvdDirectory (#6490)", () => {
  const reader = (files: Record<string, string>, existing: string[]) =>
    new FileAvdConfigReader(
      async (p: string) => {
        if (!(p in files)) {
          throw new Error(`ENOENT: ${p}`);
        }
        return files[p];
      },
      (p: string) => existing.includes(p),
      AVD_HOME,
    );

  test("resolves the conventional <avdHome>/<name>.avd directory", async () => {
    const sut = reader({}, [avdDirectory("am-api36")]);

    expect(await sut.resolveAvdDirectory("am-api36")).toBe(avdDirectory("am-api36"));
    expect(await sut.resolveAvdDirectory("absent")).toBeNull();
    expect(sut.getAvdHome()).toBe(AVD_HOME);
  });

  test("follows an <avd>.ini registry redirect to a relocated AVD", async () => {
    const relocated = path.join("/Volumes", "big-disk", "avds", "am-api34.avd");
    const sut = reader({ [path.join(AVD_HOME, "am-api34.ini")]: `path=${relocated}\n` }, [
      path.join(AVD_HOME, "am-api34.ini"),
      relocated,
    ]);

    expect(await sut.resolveAvdDirectory("am-api34")).toBe(relocated);
  });

  test("a redirect whose config.ini is still readable keeps working for readConfig", async () => {
    const relocated = path.join("/Volumes", "big-disk", "avds", "am-api34.avd");
    const sut = reader(
      {
        [path.join(AVD_HOME, "am-api34.ini")]: `path=${relocated}\n`,
        [path.join(relocated, "config.ini")]:
          "image.sysdir.1=system-images/android-34/google_apis/arm64-v8a/\n",
      },
      [path.join(AVD_HOME, "am-api34.ini"), relocated, path.join(relocated, "config.ini")],
    );

    expect((await sut.readConfig("am-api34"))?.apiLevel).toBe(34);
  });
});
