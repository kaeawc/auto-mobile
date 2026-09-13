import { describe, expect, test } from "bun:test";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import {
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

const AVD_HOME = "/home/tester/.android/avd";

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
    return this.known.has(avdName) ? `${AVD_HOME}/${avdName}.avd` : null;
  }
}

function stubEmulator(devices: BootedDevice[]) {
  return {
    getBootedDevices: async () => devices,
  } as never;
}

function recordingAdbFactory(result: ExecResult | Error) {
  const commands: string[] = [];
  const factory: AdbClientFactory = {
    create: () =>
      ({
        executeCommand: async (command: string) => {
          commands.push(command);
          if (result instanceof Error) {
            throw result;
          }
          return result;
        },
      }) as never,
  };
  return { factory, commands };
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
    const sut = service({ [`${AVD_HOME}/am-api36.avd/snapshots/snap`]: 2_100_829_021 }, {}, [
      "am-api36",
    ]);

    expect(await sut.measureVmSnapshotBytes("am-api36", "snap")).toBe(2_100_829_021);
    expect(await sut.measureVmSnapshotBytes("am-api36", "absent")).toBeNull();
    expect(await sut.measureVmSnapshotBytes("not-an-avd", "snap")).toBeNull();
  });

  test("lists in-AVD snapshot directories exactly as they are on disk", async () => {
    const sut = service(
      {
        [`${AVD_HOME}/am-api34.avd/snapshots/default_boot`]: 10,
        [`${AVD_HOME}/am-api34.avd/snapshots/sweepSnap`]: 20,
      },
      { [`${AVD_HOME}/am-api34.avd/snapshots`]: ["default_boot", "sweepSnap"] },
      ["am-api34"],
    );

    expect(await sut.listAvdSnapshotDirectories("am-api34")).toEqual([
      { snapshotName: "default_boot", sizeBytes: 10 },
      { snapshotName: "sweepSnap", sizeBytes: 20 },
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
    const sut = reader({}, [`${AVD_HOME}/am-api36.avd`]);

    expect(await sut.resolveAvdDirectory("am-api36")).toBe(`${AVD_HOME}/am-api36.avd`);
    expect(await sut.resolveAvdDirectory("absent")).toBeNull();
    expect(sut.getAvdHome()).toBe(AVD_HOME);
  });

  test("follows an <avd>.ini registry redirect to a relocated AVD", async () => {
    const relocated = "/Volumes/big-disk/avds/am-api34.avd";
    const sut = reader({ [`${AVD_HOME}/am-api34.ini`]: `path=${relocated}\n` }, [
      `${AVD_HOME}/am-api34.ini`,
      relocated,
    ]);

    expect(await sut.resolveAvdDirectory("am-api34")).toBe(relocated);
  });

  test("a redirect whose config.ini is still readable keeps working for readConfig", async () => {
    const relocated = "/Volumes/big-disk/avds/am-api34.avd";
    const sut = reader(
      {
        [`${AVD_HOME}/am-api34.ini`]: `path=${relocated}\n`,
        [`${relocated}/config.ini`]:
          "image.sysdir.1=system-images/android-34/google_apis/arm64-v8a/\n",
      },
      [`${AVD_HOME}/am-api34.ini`, relocated, `${relocated}/config.ini`],
    );

    expect((await sut.readConfig("am-api34"))?.apiLevel).toBe(34);
  });
});
