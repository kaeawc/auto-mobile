import { describe, expect, test } from "bun:test";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeviceAppInspector, findProcessIdentifier, findRunningProcessPid, isDevicectlProcessGoneError, parseDevicectlJsonOutputPath } from "../../../src/utils/ios-cmdline-tools/DeviceAppInspector";
import { isProcessAlreadyGoneError } from "../../../src/utils/ios-cmdline-tools/iosProcessErrors";
import { hashAppBundle } from "../../../src/utils/ios-cmdline-tools/AppBundleHasher";
import { FakeHostControlDeviceAppInspector } from "../../fakes/FakeHostControlDeviceAppInspector";

const bundleId = "dev.jasonpearson.automobile.ctrlproxy";

const createTempDir = async (): Promise<string> => {
  return fs.mkdtemp(join(tmpdir(), "automobile-device-"));
};

const createFixtureApp = async (root: string): Promise<string> => {
  const appDir = join(root, "CtrlProxyApp.app");
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(join(appDir, "Info.plist"), "info", "utf-8");
  return appDir;
};

const createFakeLogger = () => {
  const debugMessages: string[] = [];
  const warnMessages: string[] = [];
  return {
    debugMessages,
    warnMessages,
    debug(message: string) {
      debugMessages.push(message);
    },
    warn(message: string) {
      warnMessages.push(message);
    }
  };
};

const parseArgValue = (command: string, arg: string): string | null => {
  const match = command.match(new RegExp(`${arg}\\s+([^\\s]+)`));
  if (!match) {
    return null;
  }
  return match[1].replace(/^['"]|['"]$/g, "");
};

describe("DeviceAppInspector", () => {
  test("computes installed app hash via devicectl copy", async () => {
    const workDir = await createTempDir();
    const fixtureApp = await createFixtureApp(workDir);
    const fixtureHash = await hashAppBundle(fixtureApp);
    const hostControl = new FakeHostControlDeviceAppInspector();

    const exec = async (command: string) => {
      if (command.includes("device info apps")) {
        const jsonPath = parseDevicectlJsonOutputPath(command);
        if (jsonPath) {
          const payload = {
            apps: [
              {
                bundleIdentifier: bundleId,
                bundleURL: "file:///private/var/containers/Bundle/Application/ABC/CtrlProxyApp.app"
              }
            ]
          };
          await fs.writeFile(jsonPath, JSON.stringify(payload), "utf-8");
        }
      }
      if (command.includes("device copy from")) {
        const destination = parseArgValue(command, "--destination");
        if (destination) {
          const target = join(destination, "CtrlProxyApp.app");
          await fs.mkdir(target, { recursive: true });
          await fs.copyFile(join(fixtureApp, "Info.plist"), join(target, "Info.plist"));
        }
      }
      return {
        stdout: "",
        stderr: "",
        toString() { return this.stdout; },
        trim() { return this.stdout.trim(); },
        includes(searchString: string) { return this.stdout.includes(searchString); }
      };
    };

    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec,
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    const hash = await inspector.getInstalledAppBundleHash("device-udid", bundleId);
    expect(hash).toBe(fixtureHash);
  });

  test("delegates app hash to host control when enabled", async () => {
    const hostControl = new FakeHostControlDeviceAppInspector();
    hostControl.setUseHostControl(true);
    hostControl.setRunningInDocker(true);
    hostControl.setAvailable(true);
    hostControl.setAppHash("host-hash");

    const inspector = new DeviceAppInspector({
      platform: () => "linux",
      exec: async () => ({
        stdout: "",
        stderr: "",
        toString() { return this.stdout; },
        trim() { return this.stdout.trim(); },
        includes(searchString: string) { return this.stdout.includes(searchString); }
      }),
      readFile: async () => "",
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    const hash = await inspector.getInstalledAppBundleHash("device-udid", bundleId);
    expect(hash).toBe("host-hash");
  });

  test("computes simulator app hash via simctl get_app_container", async () => {
    const workDir = await createTempDir();
    const fixtureApp = await createFixtureApp(workDir);
    const fixtureHash = await hashAppBundle(fixtureApp);
    const hostControl = new FakeHostControlDeviceAppInspector();

    const exec = async (command: string) => {
      if (command.includes("simctl get_app_container")) {
        return {
          stdout: fixtureApp + "\n",
          stderr: "",
          toString() { return this.stdout; },
          trim() { return this.stdout.trim(); },
          includes(searchString: string) { return this.stdout.includes(searchString); }
        };
      }
      return {
        stdout: "",
        stderr: "",
        toString() { return this.stdout; },
        trim() { return this.stdout.trim(); },
        includes(searchString: string) { return this.stdout.includes(searchString); }
      };
    };

    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec,
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    const hash = await inspector.getInstalledAppBundleHash("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", bundleId, true);
    expect(hash).toBe(fixtureHash);
  });

  test("logs missing simulator app bundle lookup at debug rather than warn", async () => {
    const hostControl = new FakeHostControlDeviceAppInspector();
    const fakeLogger = createFakeLogger();
    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec: async command => {
        if (command.includes("simctl get_app_container")) {
          throw new Error("No such file or directory");
        }
        return {
          stdout: "",
          stderr: "",
          toString() { return this.stdout; },
          trim() { return this.stdout.trim(); },
          includes(searchString: string) { return this.stdout.includes(searchString); }
        };
      },
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: fakeLogger,
      hostControl
    });

    const hash = await inspector.getInstalledAppBundleHash(
      "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      `${bundleId}.XCTestServiceApp`,
      true
    );

    expect(hash).toBeNull();
    expect(fakeLogger.warnMessages).toEqual([]);
    expect(fakeLogger.debugMessages).toHaveLength(1);
    expect(fakeLogger.debugMessages[0]).toContain("Failed to read simulator app bundle");
    expect(fakeLogger.debugMessages[0]).toContain(`${bundleId}.XCTestServiceApp`);
    expect(fakeLogger.debugMessages[0]).toContain("No such file or directory");
  });

  test("keeps real simulator app bundle lookup failures at warn", async () => {
    const hostControl = new FakeHostControlDeviceAppInspector();
    const fakeLogger = createFakeLogger();
    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec: async command => {
        if (command.includes("simctl get_app_container")) {
          throw new Error("Invalid device: simulator is not booted");
        }
        return {
          stdout: "",
          stderr: "",
          toString() { return this.stdout; },
          trim() { return this.stdout.trim(); },
          includes(searchString: string) { return this.stdout.includes(searchString); }
        };
      },
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: fakeLogger,
      hostControl
    });

    const hash = await inspector.getInstalledAppBundleHash(
      "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      bundleId,
      true
    );

    expect(hash).toBeNull();
    expect(fakeLogger.warnMessages).toHaveLength(1);
    expect(fakeLogger.warnMessages[0]).toContain("Failed to read simulator app bundle");
    expect(fakeLogger.warnMessages[0]).toContain(bundleId);
    expect(fakeLogger.warnMessages[0]).toContain("Invalid device");
    expect(fakeLogger.debugMessages).toEqual([]);
  });

  test("keeps physical device installed bundle lookup failures at warn", async () => {
    const hostControl = new FakeHostControlDeviceAppInspector();
    const fakeLogger = createFakeLogger();
    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec: async command => {
        if (command.includes("devicectl device info apps")) {
          throw new Error("devicectl unavailable");
        }
        return {
          stdout: "",
          stderr: "",
          toString() { return this.stdout; },
          trim() { return this.stdout.trim(); },
          includes(searchString: string) { return this.stdout.includes(searchString); }
        };
      },
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: fakeLogger,
      hostControl
    });

    const hash = await inspector.getInstalledAppBundleHash("device-udid", bundleId);

    expect(hash).toBeNull();
    expect(fakeLogger.warnMessages).toHaveLength(1);
    expect(fakeLogger.warnMessages[0]).toContain("Failed to read installed app bundle");
    expect(fakeLogger.debugMessages).toEqual([]);
  });

  test("keeps simulator app bundle hashing failures at warn", async () => {
    const hostControl = new FakeHostControlDeviceAppInspector();
    const fakeLogger = createFakeLogger();
    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec: async command => {
        if (command.includes("simctl get_app_container")) {
          return {
            stdout: "/tmp/missing/ExistingApp.app\n",
            stderr: "",
            toString() { return this.stdout; },
            trim() { return this.stdout.trim(); },
            includes(searchString: string) { return this.stdout.includes(searchString); }
          };
        }
        return {
          stdout: "",
          stderr: "",
          toString() { return this.stdout; },
          trim() { return this.stdout.trim(); },
          includes(searchString: string) { return this.stdout.includes(searchString); }
        };
      },
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: fakeLogger,
      hostControl
    });

    const hash = await inspector.getInstalledAppBundleHash(
      "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      bundleId,
      true
    );

    expect(hash).toBeNull();
    expect(fakeLogger.warnMessages).toHaveLength(1);
    expect(fakeLogger.warnMessages[0]).toContain("Failed to hash simulator app bundle");
    expect(fakeLogger.debugMessages).toEqual([]);
  });

  test("uninstallApp uses simctl for simulators", async () => {
    const commands: string[] = [];
    const hostControl = new FakeHostControlDeviceAppInspector();
    const exec = async (command: string) => {
      commands.push(command);
      return {
        stdout: "",
        stderr: "",
        toString() { return this.stdout; },
        trim() { return this.stdout.trim(); },
        includes(searchString: string) { return this.stdout.includes(searchString); }
      };
    };

    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec,
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    await inspector.uninstallApp("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", bundleId, true);

    expect(commands.some(command => command.includes("simctl uninstall"))).toBe(true);
    expect(commands.some(command => command.includes(bundleId))).toBe(true);
    expect(commands.every(command => !command.includes("devicectl"))).toBe(true);
  });

  test("uninstallApp issues devicectl uninstall command", async () => {
    const commands: string[] = [];
    const hostControl = new FakeHostControlDeviceAppInspector();
    const exec = async (command: string) => {
      commands.push(command);
      return {
        stdout: "",
        stderr: "",
        toString() { return this.stdout; },
        trim() { return this.stdout.trim(); },
        includes(searchString: string) { return this.stdout.includes(searchString); }
      };
    };

    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec,
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    await inspector.uninstallApp("device-udid", bundleId);

    expect(commands.some(command => command.includes("devicectl device uninstall app"))).toBe(true);
    expect(commands.some(command => command.includes(bundleId))).toBe(true);
  });

  test("clearAppDataViaReinstall copies the bundle, uninstalls, then reinstalls it", async () => {
    const workDir = await createTempDir();
    const fixtureApp = await createFixtureApp(workDir);
    const hostControl = new FakeHostControlDeviceAppInspector();
    const commands: string[] = [];

    const exec = async (command: string) => {
      commands.push(command);
      if (command.includes("device info apps")) {
        const jsonPath = parseDevicectlJsonOutputPath(command);
        if (jsonPath) {
          const payload = { apps: [{ bundleIdentifier: bundleId, bundleURL: "file:///private/var/containers/Bundle/Application/ABC/CtrlProxyApp.app" }] };
          await fs.writeFile(jsonPath, JSON.stringify(payload), "utf-8");
        }
      }
      if (command.includes("device copy from")) {
        const destination = parseArgValue(command, "--destination");
        if (destination) {
          const target = join(destination, "CtrlProxyApp.app");
          await fs.mkdir(target, { recursive: true });
          await fs.copyFile(join(fixtureApp, "Info.plist"), join(target, "Info.plist"));
        }
      }
      return {
        stdout: "",
        stderr: "",
        toString() { return this.stdout; },
        trim() { return this.stdout.trim(); },
        includes(searchString: string) { return this.stdout.includes(searchString); }
      };
    };

    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec,
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    await inspector.clearAppDataViaReinstall("device-udid", bundleId);

    const uninstallIdx = commands.findIndex(c => c.includes("devicectl device uninstall app"));
    const installIdx = commands.findIndex(c => c.includes("devicectl device install app"));
    expect(uninstallIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThanOrEqual(0);
    // Must uninstall (wipes data) before reinstalling the copied bundle.
    expect(uninstallIdx).toBeLessThan(installIdx);
    expect(commands[installIdx]).toContain("CtrlProxyApp.app");
  });

  test("clearAppDataViaReinstall throws when the installed bundle cannot be resolved", async () => {
    const hostControl = new FakeHostControlDeviceAppInspector();
    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      // info apps writes no/empty json → bundle entry not found
      exec: async (command: string) => {
        if (command.includes("device info apps")) {
          const jsonPath = parseDevicectlJsonOutputPath(command);
          if (jsonPath) { await fs.writeFile(jsonPath, JSON.stringify({ apps: [] }), "utf-8"); }
        }
        return {
          stdout: "", stderr: "",
          toString() { return this.stdout; },
          trim() { return this.stdout.trim(); },
          includes(searchString: string) { return this.stdout.includes(searchString); }
        };
      },
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    await expect(inspector.clearAppDataViaReinstall("device-udid", bundleId)).rejects.toThrow();
  });

  test("clearAppDataViaReinstall fails explicitly under host control (no copy primitive)", async () => {
    const hostControl = new FakeHostControlDeviceAppInspector();
    hostControl.setUseHostControl(true);
    hostControl.setRunningInDocker(true);
    hostControl.setAvailable(true);

    const commands: string[] = [];
    const inspector = new DeviceAppInspector({
      platform: () => "linux",
      exec: async (command: string) => {
        commands.push(command);
        return {
          stdout: "", stderr: "",
          toString() { return this.stdout; },
          trim() { return this.stdout.trim(); },
          includes(searchString: string) { return this.stdout.includes(searchString); }
        };
      },
      readFile: async () => "",
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    // Explicit, actionable error — not the misleading "could not resolve bundle".
    await expect(inspector.clearAppDataViaReinstall("device-udid", bundleId)).rejects.toThrow(/host control/i);
    // And it does not attempt the darwin devicectl info/copy flow.
    expect(commands.every(c => !c.includes("devicectl"))).toBe(true);
  });

  test("clearAppDataViaReinstall surfaces the install error (not 'could not resolve') when reinstall fails after uninstall", async () => {
    const workDir = await createTempDir();
    const fixtureApp = await createFixtureApp(workDir);
    const hostControl = new FakeHostControlDeviceAppInspector();
    const commands: string[] = [];

    const exec = async (command: string) => {
      commands.push(command);
      if (command.includes("device info apps")) {
        const jsonPath = parseDevicectlJsonOutputPath(command);
        if (jsonPath) {
          const payload = { apps: [{ bundleIdentifier: bundleId, bundleURL: "file:///private/var/containers/Bundle/Application/ABC/CtrlProxyApp.app" }] };
          await fs.writeFile(jsonPath, JSON.stringify(payload), "utf-8");
        }
      }
      if (command.includes("device copy from")) {
        const destination = parseArgValue(command, "--destination");
        if (destination) {
          const target = join(destination, "CtrlProxyApp.app");
          await fs.mkdir(target, { recursive: true });
          await fs.copyFile(join(fixtureApp, "Info.plist"), join(target, "Info.plist"));
        }
      }
      // Uninstall succeeds; the reinstall (install app) fails on-device.
      if (command.includes("device install app")) {
        throw new Error("devicectl install failed: device locked");
      }
      return {
        stdout: "",
        stderr: "",
        toString() { return this.stdout; },
        trim() { return this.stdout.trim(); },
        includes(searchString: string) { return this.stdout.includes(searchString); }
      };
    };

    const inspector = new DeviceAppInspector({
      platform: () => "darwin",
      exec,
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl
    });

    // The real install error must propagate — not be masked as "could not resolve".
    await expect(inspector.clearAppDataViaReinstall("device-udid", bundleId))
      .rejects.toThrow(/install failed: device locked/);
    // The uninstall did run (app was removed), so the failure is actionable.
    expect(commands.some(c => c.includes("device uninstall app"))).toBe(true);
  });
});

describe("DeviceAppInspector launch (devicectl)", () => {
  const makeExecResult = (stdout = "") => ({
    stdout,
    stderr: "",
    toString() { return this.stdout; },
    trim() { return this.stdout.trim(); },
    includes(searchString: string) { return this.stdout.includes(searchString); }
  });

  const createInspector = (opts: {
    platform?: NodeJS.Platform;
    exec: (command: string) => Promise<ReturnType<typeof makeExecResult>>;
    hostControl?: FakeHostControlDeviceAppInspector;
  }) => {
    return new DeviceAppInspector({
      platform: () => opts.platform ?? "darwin",
      exec: opts.exec,
      readFile: async path => fs.readFile(path, "utf-8"),
      mkdtemp: async prefix => fs.mkdtemp(prefix),
      rm: async path => fs.rm(path, { recursive: true, force: true }),
      readdir: async path => fs.readdir(path),
      stat: async path => fs.stat(path),
      tmpdir,
      logger: createFakeLogger(),
      hostControl: opts.hostControl ?? new FakeHostControlDeviceAppInspector()
    });
  };

  test("launchApp issues devicectl process launch with --terminate-existing and parses the PID", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => {
      commands.push(command);
      if (command.includes("device process launch")) {
        const jsonPath = parseDevicectlJsonOutputPath(command);
        if (jsonPath) {
          await fs.writeFile(jsonPath, JSON.stringify({
            info: { outcome: "success" },
            result: { process: { processIdentifier: 4321, executable: "file:///CtrlProxyApp.app/CtrlProxyApp" } }
          }), "utf-8");
        }
      }
      return makeExecResult();
    };

    const inspector = createInspector({ exec });
    const result = await inspector.launchApp("device-udid", bundleId, { terminateExisting: true });

    expect(result.success).toBe(true);
    expect(result.pid).toBe(4321);
    const launchCommand = commands.find(c => c.includes("device process launch"))!;
    expect(launchCommand).toContain("xcrun devicectl device process launch");
    expect(launchCommand).toContain("--device device-udid");
    expect(launchCommand).toContain("--terminate-existing");
    expect(launchCommand).toContain("--json-output");
    expect(launchCommand).toContain(bundleId);
    // Simulator tool must never be invoked for a physical launch.
    expect(commands.every(c => !c.includes("simctl"))).toBe(true);
  });

  test("launchApp omits --terminate-existing when not requested", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => {
      commands.push(command);
      if (command.includes("device process launch")) {
        const jsonPath = parseDevicectlJsonOutputPath(command);
        if (jsonPath) {
          await fs.writeFile(jsonPath, JSON.stringify({ result: { process: { processIdentifier: 10 } } }), "utf-8");
        }
      }
      return makeExecResult();
    };

    const inspector = createInspector({ exec });
    const result = await inspector.launchApp("device-udid", bundleId);

    expect(result.success).toBe(true);
    expect(result.pid).toBe(10);
    const launchCommand = commands.find(c => c.includes("device process launch"))!;
    expect(launchCommand).not.toContain("--terminate-existing");
  });

  test("launchApp returns success:false with the devicectl error when launch fails", async () => {
    const exec = async (command: string) => {
      if (command.includes("device process launch")) {
        throw new Error("The operation couldn't be completed. Application not found.");
      }
      return makeExecResult();
    };

    const inspector = createInspector({ exec });
    const result = await inspector.launchApp("device-udid", bundleId, { terminateExisting: true });

    expect(result.success).toBe(false);
    expect(result.pid).toBeUndefined();
    expect(result.error).toContain("Application not found");
  });

  test("launchApp returns an explicit macOS error on non-darwin without shelling out", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => { commands.push(command); return makeExecResult(); };

    const inspector = createInspector({ platform: "linux", exec });
    const result = await inspector.launchApp("device-udid", bundleId);

    expect(result.success).toBe(false);
    expect(result.error).toContain("macOS");
    expect(commands).toEqual([]);
  });

  test("launchApp returns an explicit host-control error without shelling out", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => { commands.push(command); return makeExecResult(); };
    const hostControl = new FakeHostControlDeviceAppInspector();
    hostControl.setUseHostControl(true);
    hostControl.setRunningInDocker(true);
    hostControl.setAvailable(true);

    const inspector = createInspector({ platform: "linux", exec, hostControl });
    const result = await inspector.launchApp("device-udid", bundleId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/host control/i);
    expect(commands.every(c => !c.includes("devicectl"))).toBe(true);
  });

  test("findProcessIdentifier reads result.process.processIdentifier and falls back to a deep search", () => {
    expect(findProcessIdentifier({ result: { process: { processIdentifier: 7 } } })).toBe(7);
    expect(findProcessIdentifier({ a: { b: [{ processIdentifier: 9 }] } })).toBe(9);
    expect(findProcessIdentifier({ result: {} })).toBeUndefined();
  });
});

describe("findRunningProcessPid", () => {
  const bundlePath = "/private/var/containers/Bundle/Application/ABC/MyApp.app";

  test("matches a process whose executable lives inside the bundle path", () => {
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 100, executable: "/usr/libexec/other" },
          { processIdentifier: 4321, executable: `${bundlePath}/MyApp` }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBe(4321);
  });

  test("normalizes file:// executable URLs before matching", () => {
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 55, executable: `file://${bundlePath}/MyApp` }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBe(55);
  });

  test("supports executable given as an object with a url/path", () => {
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 77, executable: { url: `file://${bundlePath}/MyApp` } }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBe(77);
  });

  test("supports the `pid` field name as an alias for processIdentifier", () => {
    const data = { runningProcesses: [{ pid: 88, executable: `${bundlePath}/MyApp` }] };
    expect(findRunningProcessPid(data, bundlePath)).toBe(88);
  });

  test("tolerates a stringified integer PID", () => {
    const data = { runningProcesses: [{ processIdentifier: "88", executable: `${bundlePath}/MyApp` }] };
    expect(findRunningProcessPid(data, bundlePath)).toBe(88);
  });

  test("matches the main app binary, never a nested .appex extension inside the bundle", () => {
    // Extension listed FIRST — a naive prefix match would wrongly kill it.
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 200, executable: `${bundlePath}/PlugIns/Foo.appex/Foo` },
          { processIdentifier: 100, executable: `${bundlePath}/MyApp` }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBe(100);
  });

  test("does not match when only a nested .appex extension is running (no main process)", () => {
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 200, executable: `${bundlePath}/PlugIns/Foo.appex/Foo` }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBeNull();
  });

  test("falls back to executable basename when the process path root differs from the bundle URL", () => {
    // Real-device risk: info-processes reports a /var container root while
    // info-apps reported /private/var — strict prefix misses, basename catches.
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 321, executable: "/var/containers/Bundle/Application/XYZ/MyApp.app/MyApp" }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBe(321);
  });

  test("basename fallback still excludes an extension binary with a different basename", () => {
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 9, executable: "/var/containers/Bundle/Application/XYZ/MyApp.app/PlugIns/Foo.appex/Foo" }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBeNull();
  });

  test("returns null when no executable is inside the bundle path", () => {
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 1, executable: "/usr/libexec/other" },
          { processIdentifier: 2, executable: "/private/var/containers/Bundle/Application/XYZ/Another.app/Another" }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBeNull();
  });

  test("does not match a different app whose path merely shares a prefix string", () => {
    // MyApp.app vs MyApp.app.extension — must not be treated as inside MyApp.app.
    const data = {
      result: {
        runningProcesses: [
          { processIdentifier: 9, executable: `${bundlePath}.extension/Plugin` }
        ]
      }
    };
    expect(findRunningProcessPid(data, bundlePath)).toBeNull();
  });

  test("returns null for empty/invalid payloads", () => {
    expect(findRunningProcessPid({}, bundlePath)).toBeNull();
    expect(findRunningProcessPid({ result: { runningProcesses: [] } }, bundlePath)).toBeNull();
    expect(findRunningProcessPid(null, bundlePath)).toBeNull();
  });
});

describe("DeviceAppInspector terminate (devicectl)", () => {
  const bundlePath = "/private/var/containers/Bundle/Application/ABC/CtrlProxyApp.app";
  const makeExecResult = (stdout = "") => ({
    stdout,
    stderr: "",
    toString() { return this.stdout; },
    trim() { return this.stdout.trim(); },
    includes(searchString: string) { return this.stdout.includes(searchString); }
  });

  const createInspector = (opts: {
    platform?: NodeJS.Platform;
    exec: (command: string) => Promise<ReturnType<typeof makeExecResult>>;
    hostControl?: FakeHostControlDeviceAppInspector;
  }) => new DeviceAppInspector({
    platform: () => opts.platform ?? "darwin",
    exec: opts.exec,
    readFile: async path => fs.readFile(path, "utf-8"),
    mkdtemp: async prefix => fs.mkdtemp(prefix),
    rm: async path => fs.rm(path, { recursive: true, force: true }),
    readdir: async path => fs.readdir(path),
    stat: async path => fs.stat(path),
    tmpdir,
    logger: createFakeLogger(),
    hostControl: opts.hostControl ?? new FakeHostControlDeviceAppInspector()
  });

  const writeAppsJson = async (command: string, installed: boolean) => {
    const jsonPath = parseDevicectlJsonOutputPath(command);
    if (jsonPath) {
      const payload = installed
        ? { apps: [{ bundleIdentifier: bundleId, bundleURL: `file://${bundlePath}` }] }
        : { apps: [] };
      await fs.writeFile(jsonPath, JSON.stringify(payload), "utf-8");
    }
  };

  test("terminates a running app with `process terminate --kill --quiet` and reports {wasInstalled:true, wasRunning:true}", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => {
      commands.push(command);
      if (command.includes("device info apps")) {
        await writeAppsJson(command, true);
      }
      if (command.includes("device info processes")) {
        const jsonPath = parseDevicectlJsonOutputPath(command);
        if (jsonPath) {
          await fs.writeFile(jsonPath, JSON.stringify({
            result: { runningProcesses: [{ processIdentifier: 4321, executable: `${bundlePath}/CtrlProxyApp` }] }
          }), "utf-8");
        }
      }
      return makeExecResult();
    };

    const inspector = createInspector({ exec });
    const result = await inspector.terminateApp("device-udid", bundleId);

    expect(result).toEqual({ wasInstalled: true, wasRunning: true });
    // 2882's dedicated terminate verb, not raw `process signal --signal SIGKILL`.
    const terminateCommand = commands.find(c => c.includes("device process terminate"));
    expect(terminateCommand).toBeDefined();
    expect(terminateCommand).toContain("xcrun devicectl device process terminate");
    expect(terminateCommand).toContain("--device device-udid");
    expect(terminateCommand).toContain("--pid 4321");
    expect(terminateCommand).toContain("--kill");
    expect(terminateCommand).toContain("--quiet");
    // Simulator tool must never be invoked for a physical terminate.
    expect(commands.every(c => !c.includes("simctl"))).toBe(true);
    // Must not shell out to the raw signal verb.
    expect(commands.every(c => !c.includes("device process signal"))).toBe(true);
  });

  test("reports {wasInstalled:true, wasRunning:false} and issues no terminate when not running", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => {
      commands.push(command);
      if (command.includes("device info apps")) {
        await writeAppsJson(command, true);
      }
      if (command.includes("device info processes")) {
        const jsonPath = parseDevicectlJsonOutputPath(command);
        if (jsonPath) {
          await fs.writeFile(jsonPath, JSON.stringify({ result: { runningProcesses: [] } }), "utf-8");
        }
      }
      return makeExecResult();
    };

    const inspector = createInspector({ exec });
    const result = await inspector.terminateApp("device-udid", bundleId);

    expect(result).toEqual({ wasInstalled: true, wasRunning: false });
    expect(commands.some(c => c.includes("device process terminate"))).toBe(false);
  });

  test("reports {wasInstalled:false, wasRunning:false} and never queries processes when not installed", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => {
      commands.push(command);
      if (command.includes("device info apps")) {
        await writeAppsJson(command, false);
      }
      return makeExecResult();
    };

    const inspector = createInspector({ exec });
    const result = await inspector.terminateApp("device-udid", bundleId);

    expect(result).toEqual({ wasInstalled: false, wasRunning: false });
    expect(commands.some(c => c.includes("device info processes"))).toBe(false);
    expect(commands.some(c => c.includes("device process terminate"))).toBe(false);
  });

  test("throws a clear macOS error on non-darwin without shelling out", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => { commands.push(command); return makeExecResult(); };

    const inspector = createInspector({ platform: "linux", exec });

    await expect(inspector.terminateApp("device-udid", bundleId)).rejects.toThrow(/macOS/);
    expect(commands).toEqual([]);
  });

  test("throws an explicit host-control error without shelling out", async () => {
    const commands: string[] = [];
    const exec = async (command: string) => { commands.push(command); return makeExecResult(); };
    const hostControl = new FakeHostControlDeviceAppInspector();
    hostControl.setUseHostControl(true);
    hostControl.setRunningInDocker(true);
    hostControl.setAvailable(true);

    const inspector = createInspector({ platform: "linux", exec, hostControl });

    await expect(inspector.terminateApp("device-udid", bundleId)).rejects.toThrow(/host control/i);
    expect(commands.every(c => !c.includes("devicectl"))).toBe(true);
  });

  // Issue #3054: the PID can exit between `info processes` resolution and the
  // kill (a real on-device race). devicectl then exits non-zero and promisified
  // exec rejects; the app is nonetheless effectively terminated, so we must not
  // surface a false success:false — mirroring the simulator path's
  // isSimctlNotRunningError tolerance.
  const runningProcessesExec = (
    commands: string[],
    onTerminate: (command: string) => void
  ) => async (command: string) => {
    commands.push(command);
    if (command.includes("device info apps")) {
      await writeAppsJson(command, true);
    }
    if (command.includes("device info processes")) {
      const jsonPath = parseDevicectlJsonOutputPath(command);
      if (jsonPath) {
        await fs.writeFile(jsonPath, JSON.stringify({
          result: { runningProcesses: [{ processIdentifier: 4321, executable: `${bundlePath}/CtrlProxyApp` }] }
        }), "utf-8");
      }
    }
    if (command.includes("device process terminate")) {
      onTerminate(command);
    }
    return makeExecResult();
  };

  test("tolerates an already-exited PID: a devicectl 'no such process' terminate failure reports {wasInstalled:true, wasRunning:true} instead of throwing", async () => {
    const commands: string[] = [];
    // Real devicectl ESRCH text lives on stderr, not in the promisified message.
    const exec = runningProcessesExec(commands, () => {
      throw Object.assign(
        new Error("Command failed: xcrun devicectl device process terminate --pid 4321 --kill --quiet"),
        { stderr: "ERROR: The operation couldn’t be completed. No such process (NSPOSIXErrorDomain error 3.)" }
      );
    });

    const inspector = createInspector({ exec });
    const result = await inspector.terminateApp("device-udid", bundleId);

    expect(result).toEqual({ wasInstalled: true, wasRunning: true });
    // The dedicated terminate verb was still attempted before the race surfaced.
    expect(commands.some(c => c.includes("device process terminate"))).toBe(true);
  });

  test("still throws when the terminate fails for an unrelated reason (device locked)", async () => {
    const commands: string[] = [];
    const exec = runningProcessesExec(commands, () => {
      throw Object.assign(
        new Error("Command failed: xcrun devicectl device process terminate --pid 4321 --kill --quiet"),
        { stderr: "ERROR: The device is locked. Unlock it and try again." }
      );
    });

    const inspector = createInspector({ exec });
    // The original devicectl error propagates unchanged (its diagnostic lives on
    // stderr); we only assert it is not swallowed, then confirm the stderr text.
    const thrown = await inspector.terminateApp("device-udid", bundleId).then(
      () => { throw new Error("expected terminateApp to reject"); },
      (error: unknown) => error
    );
    expect((thrown as { stderr?: string }).stderr).toMatch(/locked/i);
    expect(commands.some(c => c.includes("device process terminate"))).toBe(true);
  });
});

describe("isDevicectlProcessGoneError", () => {
  test("matches ESRCH / already-exited devicectl phrasings (case-insensitive)", () => {
    expect(isDevicectlProcessGoneError("The operation couldn’t be completed. No such process (NSPOSIXErrorDomain error 3.)")).toBe(true);
    expect(isDevicectlProcessGoneError("No such process")).toBe(true);
    expect(isDevicectlProcessGoneError("The process is not running")).toBe(true);
    expect(isDevicectlProcessGoneError("The process is no longer running")).toBe(true);
    expect(isDevicectlProcessGoneError("found nothing to terminate")).toBe(true);
    // Bare POSIX ESRCH code without the "No such process" strerror gloss —
    // some devicectl/OS builds emit only this.
    expect(isDevicectlProcessGoneError("Terminate failed: NSPOSIXErrorDomain error 3")).toBe(true);
  });

  test("does not match unrelated devicectl failures", () => {
    expect(isDevicectlProcessGoneError("The device is locked.")).toBe(false);
    expect(isDevicectlProcessGoneError("Could not connect to the device.")).toBe(false);
    expect(isDevicectlProcessGoneError("Unable to terminate: permission denied")).toBe(false);
    expect(isDevicectlProcessGoneError("")).toBe(false);
    // The "not running" family is scoped to the *process* — a device/CoreDevice
    // "not running" must NOT be swallowed as an already-exited PID.
    expect(isDevicectlProcessGoneError("The device is not running.")).toBe(false);
    expect(isDevicectlProcessGoneError("CoreDevice tunnel is not running")).toBe(false);
  });

  // Drift guard (issue #3076): devicectl must stay a *superset* of the shared
  // matcher. If someone drops the `isProcessAlreadyGoneError(...)` delegation,
  // a shared phrasing that isn't a devicectl-only extra would stop matching and
  // this fails.
  test("subsumes every shared already-gone phrasing", () => {
    for (const shared of ["no such process", "found nothing to terminate", "the process is not running"]) {
      expect(isProcessAlreadyGoneError(shared)).toBe(true);
      expect(isDevicectlProcessGoneError(shared)).toBe(true);
    }
  });
});
