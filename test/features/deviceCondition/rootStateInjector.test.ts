import { SelinuxOwner } from "../../../src/features/deviceCondition/SelinuxOwner";
import { ArtifactOwner } from "../../../src/features/deviceCondition/ArtifactOwner";
import { createIntegrityStateInjector } from "../../../src/features/deviceCondition/integrityStateInjector";
import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeStubBuilder } from "../../fakes/FakeStubBuilder";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import type { DeviceConditionInjector } from "../../../src/features/deviceCondition/DeviceConditionController";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import {
  ROOT_ARTIFACT_PATHS,
  createRootStateInjector as realCreateRootStateInjector,
  resolveRootStateInjector,
} from "../../../src/features/deviceCondition/rootStateInjector";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

function adbWith(responses: Record<string, string>): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  for (const [pattern, stdout] of Object.entries(responses)) {
    adb.setCommandResponse(pattern, execResult(stdout));
  }
  const execute = adb.execute.bind(adb);
  adb.execute = async (args, options) => {
    const result = await execute(args, options);
    if (args[0] === "install" && !result.error && !result.stdout.includes("Failure")) {
      adb.setCommandResponse(`pm list packages ${MAGISK}`, execResult(`package:${MAGISK}`));
    }
    if (args[0] === "uninstall" && !result.error && !result.stdout.includes("Failure")) {
      adb.setCommandResponse(`pm list packages ${MAGISK}`, execResult(""));
    }
    return result;
  };
  return adb;
}

const MAGISK = "com.topjohnwu.magisk";
const MAGISK_MARKER = "/data/local/tmp/automobile-rootstate-magisk";
function createRootStateInjector(adb: FakeAdbExecutor, builder = new FakeStubBuilder()) {
  return realCreateRootStateInjector(adb, undefined, undefined, builder);
}

const ROOTABLE = {
  "getprop ro.debuggable": "1",
  "getprop ro.build.type": "userdebug",
  getenforce: "Enforcing",
  remount: "remount succeeded",
};

const ALL_ARTIFACTS = ROOT_ARTIFACT_PATHS.join("\n");

/** Stateful file and SELinux responses on the existing fake; no device or clock needed. */
function adbWithFiles(initial: Record<string, string>, permissive = true) {
  const adb = adbWith(ROOTABLE);
  const files = new Map(Object.entries(initial));
  const state = { permissive };
  const execute = adb.execute.bind(adb);
  adb.execute = async (args, options) => {
    const result = await execute(args, options);
    if (args[0] !== "shell") {
      return result;
    }
    if (args[1] === "ls") {
      return execResult(
        args
          .slice(2)
          .filter((path) => files.has(path))
          .join("\n") + (args.includes("pm") ? `\n${result.stdout}` : ""),
      );
    }
    if (args[1] === "cat") {
      return execResult(files.get(args[2]) ?? "");
    }
    if (args[1] === "printf") {
      files.set(args.at(-1)!, "#!/system/bin/sh\nexit 1\n");
    }
    if (args[1] === "touch") {
      files.set(args[2].replaceAll("'", ""), "");
    }
    if (args[1] === "rm") {
      for (const path of args.slice(3)) {
        files.delete(path.replaceAll("'", ""));
      }
    }
    if (args[1] === "setenforce") {
      state.permissive = args[2] === "0";
    }
    if (args[1] === "getenforce") {
      return execResult(state.permissive ? "Permissive" : "Enforcing");
    }
    return result;
  };
  return { adb, files, state };
}

/** Make the first `times` executions whose command contains `pattern` throw, then behave normally. */
function failFirst(adb: FakeAdbExecutor, pattern: string, times: number): void {
  const real = adb.execute.bind(adb);
  let remaining = times;
  adb.execute = (args, options) => {
    if (remaining > 0 && args.join(" ").includes(pattern)) {
      remaining -= 1;
      return Promise.reject(new Error("Read-only file system"));
    }
    return real(args, options);
  };
}

describe("rootState injector (#14060)", () => {
  test("clean recovery only lists files once per call and leaves no reset", async () => {
    const { adb, files } = adbWithFiles({}, false);
    const injector = createRootStateInjector(adb);
    const controller = new DeviceConditionController((key) =>
      key === "rootState" ? injector : undefined,
    );
    expect((await controller.apply({ reset: true, rootState: "unset" })).changes).toEqual([
      { key: "rootState", status: "unchanged" },
    ]);
    expect(adb.getExecutedCommands()).toHaveLength(1);
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(adb.getExecutedCommands()).toHaveLength(3);
    expect(adb.getExecutedCommands().every((command) => command.startsWith("shell ls "))).toBe(
      true,
    );
    expect(files.size).toBe(0);
    expect(controller.hasActiveConditions()).toBe(false);
  });

  for (const failingRead of ["ls", "cat"] as const) {
    test(`a failed ${failingRead} recovery probe stays active until a successful retry`, async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const initial = {
          "/system/xbin/su": "#!/system/bin/sh\nexit 1\n",
          "/system/bin/su": "#!/system/bin/sh\nexit 1\n",
        };
        const { adb, files, state } = adbWithFiles(initial);
        let failing = true;
        const execute = adb.execute.bind(adb);
        adb.execute = async (args, options) => {
          // Let the first cat match before the second throws: adoption must be atomic.
          if (
            failing &&
            args[1] === failingRead &&
            (failingRead === "ls" || args[2] === "/system/bin/su")
          ) {
            throw new Error("probe unavailable");
          }
          return execute(args, options);
        };
        const artifacts = new ArtifactOwner();
        const selinux = new SelinuxOwner();
        const injector = realCreateRootStateInjector(
          adb,
          selinux,
          artifacts,
          new FakeStubBuilder(),
        );
        const controller = new DeviceConditionController((key) =>
          key === "rootState" ? injector : undefined,
        );
        const result = await controller.apply({ rootState: "unset" });
        const detail =
          "Could not check the device for an abandoned rootState fixture (probe unavailable). Reconnect the device and run reset again, or release the session to retry.";
        expect(result.success).toBe(false);
        expect(result.changes).toEqual([{ key: "rootState", status: "unsupported", detail }]);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(await controller.restore()).toEqual({
            restored: [],
            failures: [{ key: "rootState", error: detail }],
            verifiedClean: false,
          });
        }
        expect(controller.hasActiveConditions()).toBe(true);
        expect(state.permissive).toBe(true);
        expect(selinux.owned).toBe(false);
        expect(artifacts.plantedForOther({}, "/system/xbin/su")).toBe(false);
        expect([...files]).toEqual(Object.entries(initial));
        expect(adb.getExecutedCommands().every((command) => /^shell (ls|cat) /.test(command))).toBe(
          true,
        );
        failing = false;
        // Exercise both retry entry points with the same ADB and injector.
        if (failingRead === "ls") {
          expect(await controller.restore()).toEqual({
            restored: ["rootState"],
            failures: [],
            verifiedClean: true,
          });
        } else {
          expect((await controller.apply({ rootState: "unset" })).changes).toEqual([
            { key: "rootState", status: "cleared" },
          ]);
          expect((await controller.restore()).verifiedClean).toBe(true);
        }
        expect(files.size).toBe(0);
        expect(state.permissive).toBe(false);
        expect(selinux.owned).toBe(false);
        expect(controller.hasActiveConditions()).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("a fresh injector adopts leftover stub contents and restores Enforcing", async () => {
    const { adb, files, state } = adbWithFiles({ "/system/xbin/su": "#!/system/bin/sh\nexit 1\n" });
    const artifacts = new ArtifactOwner();
    const injector = realCreateRootStateInjector(adb, undefined, artifacts, new FakeStubBuilder());
    const outcome = await injector.apply("rooted-detectable");
    expect(artifacts.plantedForOther({}, "/system/xbin/su")).toBe(true);
    expect(adb.getExecutedCommands().some((command) => command.includes("> /system/xbin/su"))).toBe(
      false,
    );
    await outcome.reset?.();
    expect(files.size).toBe(0);
    expect(state.permissive).toBe(false);
  });

  test("a fresh injector never adopts or removes a real su", async () => {
    const content = "real userdebug su binary";
    const { adb, files, state } = adbWithFiles({ "/system/xbin/su": content }, false);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    await outcome.reset?.();
    expect([...files]).toEqual([["/system/xbin/su", content]]);
    expect(state.permissive).toBe(false);
  });

  test("apply and reset preserve Permissive with su stubs held by a live integrity injector", async () => {
    const { adb, files, state } = adbWithFiles({});
    const selinux = new SelinuxOwner();
    const artifacts = new ArtifactOwner();
    const integrity = createIntegrityStateInjector(adb, selinux, artifacts);
    const integrityOutcome = await integrity.apply("apply", undefined, {
      signals: { "su-binary": "on" },
    });
    expect(integrityOutcome.status).toBe("applied");
    expect(selinux.owned).toBe(false);
    const liveFiles = [...files];
    expect(liveFiles).toHaveLength(2);
    const root = realCreateRootStateInjector(adb, selinux, artifacts, new FakeStubBuilder());
    const outcome = await root.apply("rooted-detectable");
    expect(outcome.reset).toBeFunction();
    await outcome.reset?.();
    expect(state.permissive).toBe(true);
    expect([...files]).toEqual(liveFiles);
    expect(await root.isClean()).toBe(true);
    await integrityOutcome.reset?.();
    expect(files.size).toBe(0);
    expect(state.permissive).toBe(true);
  });

  test("recovery leaves su stubs held by a live integrity injector unclaimed", async () => {
    const { adb, files, state } = adbWithFiles({});
    const selinux = new SelinuxOwner();
    const artifacts = new ArtifactOwner();
    const integrity = createIntegrityStateInjector(adb, selinux, artifacts);
    const outcome = await integrity.apply("apply", undefined, { signals: { "su-binary": "on" } });
    expect(outcome.status).toBe("applied");
    const liveFiles = [...files];
    expect(liveFiles).toHaveLength(2);
    const root = realCreateRootStateInjector(adb, selinux, artifacts, new FakeStubBuilder());
    expect(await root.recover?.()).toBeNull();
    expect(selinux.owned).toBe(false);
    expect([...files]).toEqual(liveFiles);
    expect(state.permissive).toBe(true);
    await outcome.reset?.();
    expect(files.size).toBe(0);
    expect(state.permissive).toBe(true);
  });

  test("a second controller cannot recover a live fixture owned by the first", async () => {
    const { adb, files, state } = adbWithFiles({}, false);
    const injector = createRootStateInjector(adb);
    const resolve = (key: string) => (key === "rootState" ? injector : undefined);
    const first = new DeviceConditionController(resolve);
    const second = new DeviceConditionController(resolve);
    await first.apply({ rootState: "rooted-detectable" });
    expect((await second.apply({ rootState: "unset" })).changes[0].status).toBe("unchanged");
    expect((await second.restore()).restored).toEqual([]);
    expect(files.size).toBe(ROOT_ARTIFACT_PATHS.length + 1);
    expect(state.permissive).toBe(true);
    expect((await first.restore()).verifiedClean).toBe(true);
    expect(files.size).toBe(0);
    expect(state.permissive).toBe(false);
  });

  test("similar scripts with extra whitespace or commands are never adopted", async () => {
    const initial = {
      "/system/xbin/su": " #!/system/bin/sh\nexit 1\n",
      "/system/bin/su": "#!/system/bin/sh\nexit 1 \n",
      "/system/xbin/busybox": "#!/system/bin/sh\nexit 1\n\n",
      "/system/bin/busybox": "#!/system/bin/sh\nexit 1\necho other\n",
      "/unrelated/su": "#!/system/bin/sh\nexit 1\n",
    };
    const { adb, files } = adbWithFiles(initial);
    const controller = new DeviceConditionController((key) =>
      key === "rootState" ? createRootStateInjector(adb) : undefined,
    );
    expect((await controller.apply({ rootState: "unset" })).changes[0].status).toBe("unchanged");
    expect([...files]).toEqual(Object.entries(initial));
    expect(adb.getExecutedCommands()).not.toContain("root");
  });

  test("adoption preserves a SELinux baseline already captured by another fixture", async () => {
    const { adb, files, state } = adbWithFiles({ "/system/xbin/su": "#!/system/bin/sh\nexit 1\n" });
    const selinux = new SelinuxOwner();
    const other = {};
    await selinux.capture(adb, other);
    await selinux.set(adb, other, false);
    const injector = realCreateRootStateInjector(adb, selinux, undefined, new FakeStubBuilder());
    const outcome = await injector.apply("rooted-detectable");
    await outcome.reset?.();
    expect(files.size).toBe(0);
    expect(state.permissive).toBe(false);
    await selinux.release(adb, other);
    expect(state.permissive).toBe(true);
  });

  test("failed recovery cleanup stays owed for a later restore", async () => {
    const { adb, files, state } = adbWithFiles({ "/system/xbin/su": "#!/system/bin/sh\nexit 1\n" });
    const injector = createRootStateInjector(adb);
    const controller = new DeviceConditionController((key) =>
      key === "rootState" ? injector : undefined,
    );
    failFirst(adb, "rm -f", 1);
    expect((await controller.apply({ rootState: "unset" })).success).toBe(false);
    expect(controller.activeKeys()).toEqual(["rootState"]);
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(files.size).toBe(0);
    expect(state.permissive).toBe(false);
  });

  for (const operation of ["unset", "reset", "release"] as const) {
    test(`fresh controller ${operation} sweeps leftover files without apply`, async () => {
      const initial = Object.fromEntries(
        ROOT_ARTIFACT_PATHS.map((path) => [path, "#!/system/bin/sh\nexit 1"]),
      );
      const { adb, files, state } = adbWithFiles(initial);
      adb.setCommandResponse(`pm list packages ${MAGISK}`, execResult(`package:${MAGISK}`));
      const injector = createRootStateInjector(adb);
      const controller = new DeviceConditionController((key) =>
        key === "rootState" ? injector : undefined,
      );
      if (operation === "release") {
        expect((await controller.restore()).verifiedClean).toBe(true);
      } else {
        const result = await controller.apply(
          operation === "unset" ? { rootState: "unset" } : { reset: true },
        );
        expect(result.success).toBe(true);
      }
      expect(files.size).toBe(0);
      expect(state.permissive).toBe(false);
      expect(adb.getExecutedCommands()).not.toContain(`uninstall ${MAGISK}`);
      const listings = adb
        .getExecutedCommands()
        .filter((command) => command.startsWith("shell ls "));
      // Discovery, marker check, then removal verification; no second leftover probe.
      expect(listings).toHaveLength(3);
      expect(await controller.restore()).toEqual({
        restored: [],
        failures: [],
        verifiedClean: true,
      });
      expect(controller.hasActiveConditions()).toBe(false);
    });
  }

  test("installs the package stub and uninstalls it on reset, retaining the five paths", async () => {
    const adb = adbWith(ROOTABLE);
    const builder = new FakeStubBuilder();
    const outcome = await createRootStateInjector(adb, builder).apply("rooted-detectable");
    expect(builder.builds).toBe(1);
    expect(builder.disposed).toBe(1);
    expect(adb.getExecutedCommands()).toContain("install -r /fake/magisk.apk");
    expect(ROOT_ARTIFACT_PATHS).toHaveLength(5);
    await outcome.reset?.();
    expect(adb.getExecutedCommands()).toContain(`uninstall ${MAGISK}`);
  });

  test("writes the package marker only after install succeeds", async () => {
    const { adb, files } = adbWithFiles({}, false);
    await createRootStateInjector(adb).apply("rooted-detectable");
    expect(files.has(MAGISK_MARKER)).toBe(true);
    const commands = adb.getExecutedCommands();
    expect(commands.indexOf(`shell touch '${MAGISK_MARKER}'`)).toBeGreaterThan(
      commands.indexOf("install -r /fake/magisk.apk"),
    );
  });

  for (const marked of [true, false]) {
    test(`fresh apply and reset ${marked ? "remove a marked" : "preserve an unmarked"} leftover package`, async () => {
      const initial = Object.fromEntries(
        ROOT_ARTIFACT_PATHS.map((path) => [path, "#!/system/bin/sh\nexit 1\n"]),
      );
      const { adb, files } = adbWithFiles({
        ...initial,
        ...(marked ? { [MAGISK_MARKER]: "" } : {}),
      });
      adb.setCommandResponse(`pm list packages ${MAGISK}`, execResult(`package:${MAGISK}`));
      const builder = new FakeStubBuilder();
      const injector = createRootStateInjector(adb, builder);
      const outcome = await injector.apply("rooted-detectable");
      expect(outcome.reset).toBeFunction();
      expect(builder.builds).toBe(0);
      await outcome.reset?.();
      expect(adb.getExecutedCommands().includes(`uninstall ${MAGISK}`)).toBe(marked);
      expect((await adb.execute(["shell", "pm", "list", "packages", MAGISK])).stdout).toBe(
        marked ? "" : `package:${MAGISK}`,
      );
      expect(files.has(MAGISK_MARKER)).toBe(false);
      expect(files.size).toBe(0);
      expect(await injector.isClean()).toBe(true);
    });
  }

  test("a fresh injector recovers the marked package after the file stubs are gone", async () => {
    const { adb, files, state } = adbWithFiles({ [MAGISK_MARKER]: "" });
    adb.setCommandResponse(`pm list packages ${MAGISK}`, execResult(`package:${MAGISK}`));
    const artifacts = new ArtifactOwner();
    const injector = realCreateRootStateInjector(adb, undefined, artifacts, new FakeStubBuilder());
    const reset = await injector.recover?.();
    expect(reset).toBeFunction();
    expect(artifacts.plantedForOther({}, `package:${MAGISK}`)).toBe(true);
    await reset?.();
    expect(adb.getExecutedCommands()).toContain(`uninstall ${MAGISK}`);
    expect(files.has(MAGISK_MARKER)).toBe(false);
    const commands = adb.getExecutedCommands();
    expect(commands.indexOf(`shell rm -f '${MAGISK_MARKER}'`)).toBeGreaterThan(
      commands.lastIndexOf(`shell pm list packages ${MAGISK}`),
    );
    expect(state.permissive).toBe(false);
    expect(await injector.isClean()).toBe(true);
  });

  for (const unreadable of [false, true]) {
    test(`recovery preserves a package with ${unreadable ? "an unreadable" : "no"} marker`, async () => {
      const { adb, files } = adbWithFiles(unreadable ? { [MAGISK_MARKER]: "" } : {}, false);
      adb.setCommandResponse(`pm list packages ${MAGISK}`, execResult(`package:${MAGISK}`));
      let markerReads = 0;
      const execute = adb.execute.bind(adb);
      adb.execute = async (args, options) => {
        if (args[1] === "ls" && args[2] === MAGISK_MARKER) {
          markerReads += 1;
          if (unreadable) {
            throw new Error("marker unreadable");
          }
        }
        return execute(args, options);
      };
      const injector = createRootStateInjector(adb);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(await injector.recover?.()).toBeNull();
        expect(markerReads).toBe(1);
        expect(adb.getExecutedCommands()).not.toContain(`uninstall ${MAGISK}`);
        expect(files.has(MAGISK_MARKER)).toBe(unreadable);
        if (unreadable) {
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("rootState package marker probe failed: marker unreadable"),
            expect.any(Error),
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("failed install rolls back, disposes the APK, and leaves nothing held", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandResponse("install -r", execResult("Failure [INSTALL_FAILED_INVALID_APK]"));
    const builder = new FakeStubBuilder();
    const artifacts = new ArtifactOwner();
    const injector = realCreateRootStateInjector(adb, undefined, artifacts, builder);
    await expect(injector.apply("rooted-detectable")).rejects.toThrow(/INSTALL_FAILED/);
    for (const key of [...ROOT_ARTIFACT_PATHS, `package:${MAGISK}`]) {
      expect(artifacts.plantedForOther({}, key)).toBe(false);
    }
    expect(builder.disposed).toBe(1);
    expect(adb.getExecutedCommands()).not.toContain(`shell touch '${MAGISK_MARKER}'`);
    expect(adb.getExecutedCommands()).toContain("unroot");
    expect(await injector.isClean()).toBe(true);
    const before = adb.getExecutedCommands().length;
    await injector.apply("rooted-detectable").catch(() => undefined);
    expect(adb.getExecutedCommands().slice(before)).toContain("install -r /fake/magisk.apk");
  });

  test("a pre-existing package is held and never rebuilt or removed", async () => {
    const adb = adbWith({ ...ROOTABLE, [`pm list packages ${MAGISK}`]: `package:${MAGISK}` });
    const builder = new FakeStubBuilder();
    const outcome = await createRootStateInjector(adb, builder).apply("rooted-detectable");
    await outcome.reset?.();
    expect(builder.builds).toBe(0);
    expect(adb.getExecutedCommands()).not.toContain(`uninstall ${MAGISK}`);
  });

  test("isClean detects a remaining package even when the five files are gone", async () => {
    const adb = adbWith(ROOTABLE);
    const injector = createRootStateInjector(adb);
    await injector.apply("rooted-detectable");
    // Fake file listings are empty. Only the installed package remains.
    expect(await injector.isClean()).toBe(false);
  });

  test("a package that survives uninstall keeps reset owed and isClean false", async () => {
    const adb = adbWith(ROOTABLE);
    const injector = createRootStateInjector(adb);
    const outcome = await injector.apply("rooted-detectable");
    const execute = adb.execute.bind(adb);
    adb.execute = async (args, options) => {
      const result = await execute(args, options);
      if (args[0] === "uninstall") {
        adb.setCommandResponse(`pm list packages ${MAGISK}`, execResult(`package:${MAGISK}`));
      }
      return result;
    };
    await expect(outcome.reset?.()).rejects.toThrow(/left artifacts.*package:/);
    expect(adb.getExecutedCommands()).toContain("shell setenforce 1");
    expect(adb.getExecutedCommands()).not.toContain(`shell rm -f '${MAGISK_MARKER}'`);
    expect(await injector.isClean()).toBe(false);
    adb.execute = execute;
    await outcome.reset?.();
    expect(await injector.isClean()).toBe(true);
  });

  test("package drift triggers a reinstall without stacking resets", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(ALL_ARTIFACTS),
      execResult(""),
    ]);
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Permissive"),
    ]);
    const builder = new FakeStubBuilder();
    const injector = createRootStateInjector(adb, builder);
    const first = await injector.apply("rooted-detectable");
    adb.setCommandResponse(`pm list packages ${MAGISK}`, execResult(""));
    const second = await injector.apply("rooted-detectable");
    expect(second.status).toBe("applied");
    expect(second.reset).toBeUndefined();
    expect(builder.builds).toBe(2);
    await first.reset?.();
  });

  test("a failed SDK build rolls the file fixture back", async () => {
    const adb = adbWith(ROOTABLE);
    const injector = realCreateRootStateInjector(adb, undefined, undefined, {
      build: async () => {
        throw new Error("Install SDK build-tools and set ANDROID_HOME");
      },
    });
    await expect(injector.apply("rooted-detectable")).rejects.toThrow(/ANDROID_HOME/);
    expect(adb.getExecutedCommands()).toContain("unroot");
    expect(await injector.isClean()).toBe(true);
  });

  test("a package another fixture owns remains held until rootState releases it", async () => {
    const adb = adbWith({ ...ROOTABLE, [`pm list packages ${MAGISK}`]: `package:${MAGISK}` });
    const artifacts = new ArtifactOwner();
    const otherToken = {};
    artifacts.plant(otherToken, `package:${MAGISK}`);
    const injector = realCreateRootStateInjector(adb, undefined, artifacts, new FakeStubBuilder());
    const outcome = await injector.apply("rooted-detectable");
    expect(artifacts.removableBy(otherToken, `package:${MAGISK}`)).toBe(false);
    await outcome.reset?.();
    expect(artifacts.removableBy(otherToken, `package:${MAGISK}`)).toBe(true);
    expect(adb.getExecutedCommands()).not.toContain(`uninstall ${MAGISK}`);
    expect(await injector.isClean()).toBe(true);
  });

  test("refuses a production (Play) image with guidance toward real root", async () => {
    const adb = adbWith({ "getprop ro.debuggable": "0", "getprop ro.build.type": "user" });
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow(
      /rootState needs a non-Play image[\s\S]*#14070/,
    );
    expect(adb.getExecutedCommands().some((c) => c.includes("remount"))).toBe(false);
  });

  test("rejects an unknown value before touching the device", async () => {
    const adb = adbWith(ROOTABLE);
    await expect(createRootStateInjector(adb).apply("god-mode")).rejects.toThrow(
      /Invalid rootState/,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("applies: roots, remounts, goes permissive, and plants every artifact", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    expect(outcome.status).toBe("applied");
    const commands = adb.getExecutedCommands();
    expect(commands.indexOf("root")).toBeLessThan(commands.indexOf("remount"));
    expect(commands).toContain("shell setenforce 0");
    for (const path of ROOT_ARTIFACT_PATHS) {
      expect(commands.some((c) => c.includes(`> ${path}`))).toBe(true);
    }
    expect(commands.some((c) => c.includes("chmod 06755 /system/xbin/su"))).toBe(true);
  });

  test("a remount that leaves /system read-only explains how to boot writable", async () => {
    const adb = adbWith({ ...ROOTABLE, remount: "remount failed: Read-only file system (verity)" });
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow(
      /-writable-system/,
    );
  });

  test("a remount that exits nonzero still explains how to boot writable", async () => {
    const adb = adbWith(ROOTABLE);
    failFirst(adb, "remount", 1);
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow(
      /-writable-system/,
    );
  });

  test("reset removes artifacts, restores SELinux and unroots", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    await outcome.reset?.();
    const commands = adb.getExecutedCommands();
    expect(commands.some((c) => c.startsWith("shell rm -f ") && c.includes("Superuser.apk"))).toBe(
      true,
    );
    expect(commands).toContain("shell setenforce 1");
    expect(commands).toContain("unroot");
  });

  test("a failure while planting rolls the device back and rethrows", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandError("chmod", new Error("Read-only file system"));
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow();
    expect(adb.getExecutedCommands()).toContain("unroot");
  });

  test("isClean is false while planted artifacts exist and true after reset", async () => {
    const adb = adbWith(ROOTABLE);
    // Listings: nothing pre-existing; planted files present; then gone on the reset's readback.
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(""),
    ]);
    const injector = createRootStateInjector(adb);
    const outcome = await injector.apply("rooted-detectable");
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    expect(await injector.isClean()).toBe(true);
  });

  test("resolver only serves rootState on Android", () => {
    const android: BootedDevice = { name: "e", platform: "android", deviceId: "emulator-5554" };
    const ios: BootedDevice = { name: "s", platform: "ios", deviceId: "SIM" };
    expect(resolveRootStateInjector(android, "faults.battery")).toBeUndefined();
    expect(resolveRootStateInjector(ios, "rootState")).toBeUndefined();
    expect(resolveRootStateInjector(android, "rootState")?.key).toBe("rootState");
  });

  test("plants the stub with one quoted printf script, as the device shell will see it", async () => {
    const adb = adbWith(ROOTABLE);
    await createRootStateInjector(adb).apply("rooted-detectable");
    expect(adb.getExecutedCommands()).toContain(
      "shell printf '#!/system/bin/sh\\nexit 1\\n' > /system/xbin/su",
    );
    expect(adb.getExecutedCommands().some((c) => c.includes("sh -c"))).toBe(false);
  });

  test("a remount failure after adb root un-roots the device", async () => {
    const adb = adbWith({ ...ROOTABLE, remount: "remount failed: Read-only file system (verity)" });
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow(
      /-writable-system/,
    );
    const commands = adb.getExecutedCommands();
    expect(commands).toContain("root");
    expect(commands).toContain("unroot");
    // SELinux was never touched, so the rollback must not flip it.
    expect(commands.some((c) => c.startsWith("shell setenforce"))).toBe(false);
  });

  test("when rollback also fails, the thrown error carries the owed reset", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandError("chmod", new Error("Read-only file system"));
    adb.setCommandError("rm -f", new Error("device offline"));
    const error = await createRootStateInjector(adb)
      .apply("rooted-detectable")
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(OwedResetError);
    expect((error as OwedResetError).message).toMatch(/Cleanup also failed/);
  });

  test("reset re-acquires root before touching /system", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    const before = adb.getExecutedCommands().length;
    await outcome.reset?.();
    const resetCommands = adb.getExecutedCommands().slice(before);
    expect(resetCommands.indexOf("root")).toBeGreaterThanOrEqual(0);
    expect(resetCommands.indexOf("root")).toBeLessThan(
      resetCommands.findIndex((c) => c.startsWith("shell rm -f")),
    );
  });

  test("a repeat apply on the same injector is coalesced and keeps the original baseline", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
    ]);
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Permissive"),
    ]);
    const injector = createRootStateInjector(adb);
    const first = await injector.apply("rooted-detectable");
    expect(first.status).toBe("applied");
    const second = await injector.apply("rooted-detectable");
    expect(second.status).toBe("unchanged");
    expect(second.reset).toBeUndefined();
    // Nothing was re-applied, so SELinux was only switched once.
    expect(adb.getExecutedCommands().filter((c) => c === "shell setenforce 0")).toHaveLength(1);
  });

  test("the resolver hands back one injector per device so applies share state", () => {
    const android: BootedDevice = { name: "e", platform: "android", deviceId: "emulator-5554" };
    const other: BootedDevice = { name: "f", platform: "android", deviceId: "emulator-5556" };
    const cache = new Map<string, DeviceConditionInjector>();
    const factory = { create: () => adbWith(ROOTABLE) };
    const a = resolveRootStateInjector(android, "rootState", factory, cache);
    expect(resolveRootStateInjector(android, "rootState", factory, cache)).toBe(a);
    expect(resolveRootStateInjector(other, "rootState", factory, cache)).not.toBe(a);
  });

  test("applying twice through the controller registers one reset and restores cleanly", async () => {
    const adb = adbWith(ROOTABLE);
    // Nothing pre-existing; our planted files still there on the repeat apply; gone after reset.
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(""),
    ]);
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Permissive"),
      execResult("Enforcing"),
    ]);
    const injector = createRootStateInjector(adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ rootState: "rooted-detectable" });
    await controller.apply({ rootState: "rooted-detectable" });
    const report = await controller.restore();
    expect(report.failures).toEqual([]);
    expect(adb.getExecutedCommands().filter((c) => c === "unroot")).toHaveLength(1);
  });

  test("an artifact already on the image is left alone: not overwritten, not deleted on reset", async () => {
    const adb = adbWith(ROOTABLE);
    // A userdebug image ships a real su in /system/xbin.
    adb.setCommandResponseSequence("ls /system/xbin/su", [execResult("/system/xbin/su")]);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    const commands = adb.getExecutedCommands();
    expect(commands.some((c) => c.includes("> /system/xbin/su"))).toBe(false);
    expect(commands.some((c) => c.includes("> /system/bin/su"))).toBe(true);
    expect(outcome.detail).toMatch(/already present on the image/);

    await outcome.reset?.();
    const rm = adb.getExecutedCommands().find((c) => c.startsWith("shell rm -f "));
    expect(rm).toBeDefined();
    expect(rm).not.toContain("/system/xbin/su ");
    expect(rm?.endsWith("/system/xbin/su")).toBe(false);
  });

  test("a retry after a failed rollback keeps the original SELinux baseline", async () => {
    const adb = adbWith(ROOTABLE);
    // The first read is the real baseline; any later read would see the fixture's Permissive.
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Permissive"),
      execResult("Permissive"),
    ]);
    failFirst(adb, "chmod", 1);
    failFirst(adb, "rm -f", 1);
    const injector = createRootStateInjector(adb);

    await expect(injector.apply("rooted-detectable")).rejects.toBeInstanceOf(OwedResetError);
    const retry = await injector.apply("rooted-detectable");
    expect(retry.status).toBe("applied");
    await retry.reset?.();

    const commands = adb.getExecutedCommands();
    const lastSetenforce = commands.filter((c) => c.startsWith("shell setenforce")).at(-1);
    expect(lastSetenforce).toBe("shell setenforce 1");
    expect(commands.filter((c) => c === "shell getenforce")).toHaveLength(1);
  });

  test("a failed artifact listing stops the apply before anything on the device changes", async () => {
    const adb = adbWith({ ...ROOTABLE, "ls /system/xbin/su": "/system/bin/busybox" });
    failFirst(adb, "ls ", 1);
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow();
    const commands = adb.getExecutedCommands();
    // Nothing was written, un-rooted or toggled, and the baseline was not read yet either.
    expect(commands.filter((c) => /^(root|remount|unroot)$/.test(c))).toEqual([]);
    expect(commands.some((c) => c.startsWith("shell printf") || c.startsWith("shell chmod"))).toBe(
      false,
    );
    expect(commands.some((c) => c.startsWith("shell setenforce"))).toBe(false);
    expect(commands.filter((c) => c === "shell getenforce")).toHaveLength(0);
  });

  test("isClean fails closed when the artifact listing cannot run", async () => {
    const adb = adbWith(ROOTABLE);
    const injector = createRootStateInjector(adb);
    await injector.apply("rooted-detectable");
    failFirst(adb, "ls ", 1);
    expect(await injector.isClean()).toBe(false);
  });

  test("a repeat apply re-applies SELinux when only the mode drifted, keeping one reset and the baseline", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(""),
    ]);
    // Baseline Enforcing; after a reboot the files are still there but SELinux is Enforcing again.
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Enforcing"),
      execResult("Permissive"),
    ]);
    const injector = createRootStateInjector(adb);
    const first = await injector.apply("rooted-detectable");
    expect(first.reset).toBeDefined();

    const second = await injector.apply("rooted-detectable");
    expect(second.status).toBe("applied");
    expect(second.reset).toBeUndefined();
    expect(adb.getExecutedCommands().filter((c) => c === "shell setenforce 0")).toHaveLength(2);

    await first.reset?.();
    const lastSetenforce = adb
      .getExecutedCommands()
      .filter((c) => c.startsWith("shell setenforce"))
      .at(-1);
    expect(lastSetenforce).toBe("shell setenforce 1");
  });

  test("a reset that cannot confirm the artifacts are gone stays owed and reports them", async () => {
    const adb = adbWith(ROOTABLE);
    // Pre-existing listing: none. The reset's readback and the clean check both still see the files.
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(ALL_ARTIFACTS),
    ]);
    const injector = createRootStateInjector(adb);
    const outcome = await injector.apply("rooted-detectable");

    await expect(outcome.reset?.()).rejects.toThrow(/left artifacts on the device/);
    // SELinux was still restored and adbd un-rooted despite the failed removal check.
    expect(adb.getExecutedCommands()).toContain("unroot");
    // Nothing was forgotten: the device is not reported clean.
    expect(await injector.isClean()).toBe(false);
  });

  test("reset remounts /system writable before it removes the planted files", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    const before = adb.getExecutedCommands().length;
    await outcome.reset?.();
    const commands = adb.getExecutedCommands().slice(before);
    const remount = commands.indexOf("remount");
    expect(remount).toBeGreaterThan(commands.indexOf("root"));
    expect(remount).toBeLessThan(commands.findIndex((c) => c.startsWith("shell rm -f")));
  });

  test("a reset that cannot make /system writable stays owed instead of half-cleaning", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    // After a reboot the system partition is read-only again and remount is refused.
    adb.setCommandResponse("remount", execResult("remount failed: Read-only file system"));
    await expect(outcome.reset?.()).rejects.toThrow(/-writable-system/);
    expect(adb.getExecutedCommands().filter((c) => c.startsWith("shell rm -f"))).toHaveLength(0);
  });
});
