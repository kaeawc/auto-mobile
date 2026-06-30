import { describe, expect, test } from "bun:test";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeviceAppInspector, parseDevicectlJsonOutputPath } from "../../../src/utils/ios-cmdline-tools/DeviceAppInspector";
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
