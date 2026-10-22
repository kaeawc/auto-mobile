import { loadPhotosTccCase } from "../../helpers/iosTccPhotosFixtures";
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { ExecResult } from "../../../src/models";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import {
  SimulatorTccSqliteClient,
  SIMCTL_PRIVACY_TCC_SERVICES,
  permissionForTccService,
  tccServiceForPermission,
  type TccDatabaseFileSystem,
} from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import {
  CORESIMULATOR_DEVICE_SET_PATH_ENV,
  DAEMON_LAUNCH_CWD_ENV,
  normalizeCoreSimulatorDeviceSetPathEnv,
} from "../../../src/utils/workingDirectory";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE_ID = "12345678-1234-1234-1234-123456789ABC";

function result(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

class FakeTccFileSystem implements TccDatabaseFileSystem {
  readonly paths: string[] = [];
  error: Error | null = null;
  isFile = true;

  async stat(path: string): Promise<{ isFile(): boolean }> {
    this.paths.push(path);
    if (this.error) {
      throw this.error;
    }
    return { isFile: () => this.isFile };
  }
}

class FakeSqliteExecutor implements HostCommandExecutor {
  readonly calls: Array<{ file: string; args: string[]; options: HostCommandOptions | undefined }> =
    [];
  response: ExecResult = result("[]");
  error: Error | null = null;
  onExecute: ((options: HostCommandOptions | undefined) => Promise<ExecResult>) | null = null;

  async executeCommand(
    file: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    this.calls.push({ file, args, options });
    if (this.onExecute) {
      return this.onExecute(options);
    }
    if (this.error) {
      throw this.error;
    }
    return this.response;
  }
}

describe("SimulatorTccSqliteClient", () => {
  test("exports the deduplicated simctl-managed services without system-only services", () => {
    expect(SIMCTL_PRIVACY_TCC_SERVICES).toHaveLength(12);
    expect(new Set(SIMCTL_PRIVACY_TCC_SERVICES).size).toBe(SIMCTL_PRIVACY_TCC_SERVICES.length);
    expect(SIMCTL_PRIVACY_TCC_SERVICES).toContain("kTCCServiceAddressBook");
    expect(SIMCTL_PRIVACY_TCC_SERVICES).not.toContain("kTCCServiceLiverpool");
    expect(SIMCTL_PRIVACY_TCC_SERVICES).not.toContain("kTCCServiceUbiquity");
  });

  test("readServiceRows binds services and parses rows across clients without an auth filter", async () => {
    const executor = new FakeSqliteExecutor();
    const rows = [
      { service: "kTCCServiceAddressBook", client: "com.apple.mobilesafari", auth_value: 2 },
      { service: 'service"quoted', client: "com.example.app", auth_value: 0 },
    ];
    executor.onExecute = async () =>
      executor.calls.at(-1)?.args.at(-1) === "pragma table_info(access);"
        ? result(JSON.stringify([{ name: "service" }, { name: "client" }, { name: "auth_value" }]))
        : result(JSON.stringify(rows));
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      executor,
      fileSystem: new FakeTccFileSystem(),
      environment: {},
      homeDirectory: "/Users/tester",
    });
    const signal = new AbortController().signal;
    await expect(
      client.readServiceRows(DEVICE_ID, ["kTCCServiceAddressBook", 'service"quoted'], signal),
    ).resolves.toEqual(rows);
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[1]?.args).toEqual([
      "-readonly",
      "-json",
      "-cmd",
      ".parameter init",
      "-cmd",
      '.parameter set :service0 "kTCCServiceAddressBook"',
      "-cmd",
      '.parameter set :service1 "service\\\"quoted"',
      join(
        "/Users/tester/Library/Developer/CoreSimulator/Devices",
        DEVICE_ID,
        "data/Library/TCC/TCC.db",
      ),
      "select service, client, auth_value\nfrom access\nwhere service in (:service0, :service1);",
    ]);
    expect(executor.calls.every((call) => call.options?.signal instanceof AbortSignal)).toBe(true);
  });

  test("readServiceRows with no services returns no rows without sqlite or filesystem calls", async () => {
    const executor = new FakeSqliteExecutor();
    const fileSystem = new FakeTccFileSystem();
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      executor,
      fileSystem,
      environment: {},
    });
    await expect(client.readServiceRows(DEVICE_ID, [])).resolves.toEqual([]);
    expect(executor.calls).toEqual([]);
    expect(fileSystem.paths).toEqual([]);
  });

  test.each(["service", "client"])(
    "readServiceRows rejects a schema missing %s",
    async (missing) => {
      const executor = new FakeSqliteExecutor();
      executor.response = result(
        JSON.stringify(
          ["service", "client"].filter((column) => column !== missing).map((name) => ({ name })),
        ),
      );
      const client = new SimulatorTccSqliteClient({
        timer: new FakeTimer(),
        executor,
        fileSystem: new FakeTccFileSystem(),
        environment: {},
      });
      await expect(client.readServiceRows(DEVICE_ID, ["kTCCServiceAddressBook"])).rejects.toThrow(
        `missing required access columns: ${missing}`,
      );
      expect(executor.calls).toHaveLength(1);
    },
  );

  test("parses both full2 captured rows and ignores extra sqlite columns", async () => {
    const { rows } = await loadPhotosTccCase("full2");
    expect(rows).toEqual([
      {
        service: "kTCCServicePhotosAdd",
        client: "dev.jasonpearson.automobile.Playground",
        auth_version: 1,
        auth_value: 0,
      },
      {
        service: "kTCCServicePhotos",
        client: "dev.jasonpearson.automobile.Playground",
        auth_version: 2,
        auth_value: 2,
      },
    ]);
  });

  test("tccServiceForPermission and permissionForTccService are inverses on the canonical vocabulary (#6372 dedup)", () => {
    // These two functions - and IosSimulatorPermissions's grant/query paths -
    // all derive from the single TCC_SERVICE_BY_PERMISSION table in this
    // module. A permission that maps to a service this round-trip doesn't
    // recover would indicate the vocabulary drifted apart again.
    const canonicalPermissions = [
      "calendar",
      "camera",
      "contacts",
      "location",
      "location-always",
      "media-library",
      "microphone",
      "motion",
      "photos",
      "photos-add",
      "reminders",
      "siri",
    ];
    for (const permission of canonicalPermissions) {
      const service = tccServiceForPermission(permission);
      expect(service.startsWith("kTCCService")).toBe(true);
      expect(permissionForTccService(service)).toBe(permission);
    }
    // Unknown permissions and already-qualified services pass through unchanged.
    expect(tccServiceForPermission("kTCCServiceCamera")).toBe("kTCCServiceCamera");
    expect(permissionForTccService("kTCCServiceUnknown")).toBe("kTCCServiceUnknown");
  });

  test("anchors a relative device set at the injected environment's launch directory (#6901)", async () => {
    // The injected environment supplies both the path and its launch anchor.
    const launchDirectory = resolve("launch-project");
    const fileSystem = new FakeTccFileSystem();
    fileSystem.error = Object.assign(new Error("absent"), { code: "ENOENT" });
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      executor: new FakeSqliteExecutor(),
      fileSystem,
      environment: {
        [CORESIMULATOR_DEVICE_SET_PATH_ENV]: "custom-devices",
        [DAEMON_LAUNCH_CWD_ENV]: launchDirectory,
      },
    });
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "unavailable",
    );
    expect(fileSystem.paths).toEqual([
      join(launchDirectory, "custom-devices", DEVICE_ID, "data/Library/TCC/TCC.db"),
    ]);
  });

  test("anchors an injected relative deviceSetRoot at the injected launch directory too (#6901)", async () => {
    const launchDirectory = resolve("launch-project");
    const fileSystem = new FakeTccFileSystem();
    fileSystem.error = Object.assign(new Error("absent"), { code: "ENOENT" });
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      executor: new FakeSqliteExecutor(),
      fileSystem,
      deviceSetRoot: "relative-devices",
      environment: { [DAEMON_LAUNCH_CWD_ENV]: launchDirectory },
    });
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "unavailable",
    );
    expect(fileSystem.paths).toEqual([
      join(launchDirectory, "relative-devices", DEVICE_ID, "data/Library/TCC/TCC.db"),
    ]);
  });

  test("owns TCC path resolution and issues parameterized sqlite argv queries", async () => {
    const executor = new FakeSqliteExecutor();
    const fileSystem = new FakeTccFileSystem();
    executor.onExecute = async () => {
      const call = executor.calls.at(-1);
      return call?.args.at(-1) === "pragma table_info(access);"
        ? result(
            JSON.stringify([
              { name: "service" },
              { name: "client" },
              { name: "auth_version" },
              { name: "auth_value" },
              { name: "prompt_count" },
            ]),
          )
        : result(
            JSON.stringify([
              {
                service: "kTCCServiceCamera",
                client: "com.example.app",
                auth_version: 1,
                auth_value: 2,
                prompt_count: 1,
              },
            ]),
          );
    };
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      executor,
      fileSystem,
      homeDirectory: "/Users/test user",
      environment: {},
    });
    const databasePath = join(
      "/Users/test user",
      "Library",
      "Developer",
      "CoreSimulator",
      "Devices",
      DEVICE_ID,
      "data",
      "Library",
      "TCC",
      "TCC.db",
    );

    const rows = await client.readPermissions(DEVICE_ID, "com.example.app", ["kTCCServiceCamera"]);

    expect(rows).toEqual([
      {
        service: "kTCCServiceCamera",
        client: "com.example.app",
        auth_version: 1,
        auth_value: 2,
        prompt_count: 1,
      },
    ]);
    expect(fileSystem.paths).toEqual([databasePath]);
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]).toMatchObject({
      file: "sqlite3",
      args: ["-readonly", "-json", databasePath, "pragma table_info(access);"],
    });
    expect(executor.calls[1]?.args).toEqual([
      "-readonly",
      "-json",
      "-cmd",
      ".parameter init",
      "-cmd",
      '.parameter set :appId "com.example.app"',
      "-cmd",
      '.parameter set :service0 "kTCCServiceCamera"',
      databasePath,
      [
        "select service, client, auth_version, auth_value, prompt_count",
        "from access",
        "where client = :appId and service in (:service0);",
      ].join("\n"),
    ]);
    for (const call of executor.calls) {
      expect(call.args[0]).toBe("-readonly");
    }
  });

  test("encodes apostrophes and quotes for sqlite dot-command parameters", async () => {
    const executor = new FakeSqliteExecutor();
    executor.onExecute = async () =>
      executor.calls.at(-1)?.args.at(-1) === "pragma table_info(access);"
        ? result(JSON.stringify([{ name: "service" }, { name: "client" }]))
        : result("[]");
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      environment: {},
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });

    await client.readPermissions(DEVICE_ID, "com.example.o'hara", ['service"quoted']);

    expect(executor.calls[1]?.args).toContain('.parameter set :appId "com.example.o\'hara"');
    expect(executor.calls[1]?.args).toContain('.parameter set :service0 "service\\\"quoted"');
  });

  test("supports legacy TCC schemas that expose allowed instead of auth_value", async () => {
    const executor = new FakeSqliteExecutor();
    executor.onExecute = async () =>
      executor.calls.at(-1)?.args.at(-1) === "pragma table_info(access);"
        ? result(JSON.stringify([{ name: "service" }, { name: "client" }, { name: "allowed" }]))
        : result(
            JSON.stringify([
              { service: "kTCCServiceCamera", client: "com.example.app", allowed: 1 },
            ]),
          );
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      environment: {},
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).resolves.toEqual([
      { service: "kTCCServiceCamera", client: "com.example.app", allowed: 1 },
    ]);
    expect(executor.calls[1]?.args.at(-1)).toContain("select service, client, allowed");
  });

  test("reports unavailable or unreadable TCC databases with device context", async () => {
    const fileSystem = new FakeTccFileSystem();
    fileSystem.error = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      environment: {},
      executor: new FakeSqliteExecutor(),
      fileSystem,
      homeDirectory: "/Users/tester",
    });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      `Simulator TCC database is unavailable for ${DEVICE_ID}`,
    );
  });

  test("rejects a non-simulator UDID before resolving a host path", async () => {
    const fileSystem = new FakeTccFileSystem();
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      environment: {},
      executor: new FakeSqliteExecutor(),
      fileSystem,
      homeDirectory: "/Users/tester",
    });

    await expect(client.readPermissions("../../other-device", "com.example.app")).rejects.toThrow(
      "requires a simulator UDID",
    );
    expect(fileSystem.paths).toEqual([]);
  });

  test("classifies an unavailable sqlite3 binary and a malformed TCC database", async () => {
    const executor = new FakeSqliteExecutor();
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      environment: {},
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });
    executor.error = Object.assign(new Error("spawn sqlite3 ENOENT"), { code: "ENOENT" });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "sqlite3 is unavailable",
    );

    executor.error = new Error("file is not a database");
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      `Simulator TCC database is malformed for ${DEVICE_ID}`,
    );
  });

  test("rejects incompatible schemas and malformed sqlite JSON", async () => {
    const executor = new FakeSqliteExecutor();
    executor.response = result(JSON.stringify([{ name: "client" }]));
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      environment: {},
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "missing required access columns: service",
    );

    executor.response = result("not json");
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "sqlite3 returned malformed JSON",
    );
  });

  test("aborts the argv execution when the owned timeout elapses", async () => {
    const executor = new FakeSqliteExecutor();
    const timer = new FakeTimer();
    let capturedSignal: AbortSignal | undefined;
    executor.onExecute = async (options) =>
      new Promise<ExecResult>((_resolve, reject) => {
        capturedSignal = options?.signal;
        capturedSignal?.addEventListener(
          "abort",
          () => reject(new Error("The operation was aborted")),
          { once: true },
        );
      });
    const client = new SimulatorTccSqliteClient({
      environment: {},
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
      timer,
      timeoutMs: 123,
    });

    const pending = client.readPermissions(DEVICE_ID, "com.example.app");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(123);

    await expect(pending).rejects.toThrow(
      "Timed out after 123ms while reading simulator TCC database",
    );
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("resolves the TCC database under an injected custom device-set root", async () => {
    const executor = new FakeSqliteExecutor();
    const fileSystem = new FakeTccFileSystem();
    executor.onExecute = async () =>
      executor.calls.at(-1)?.args.at(-1) === "pragma table_info(access);"
        ? result(JSON.stringify([{ name: "service" }, { name: "client" }]))
        : result("[]");
    const customDeviceSetRoot = "/Users/tester/CustomDeviceSets/ci-job-42/Devices";
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      environment: {},
      executor,
      fileSystem,
      homeDirectory: "/Users/tester",
      deviceSetRoot: customDeviceSetRoot,
    });
    const expectedPath = join(customDeviceSetRoot, DEVICE_ID, "data", "Library", "TCC", "TCC.db");

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).resolves.toEqual([]);

    expect(fileSystem.paths).toEqual([expectedPath]);
  });

  test("honors the injected environment when no deviceSetRoot dependency is injected", async () => {
    const fileSystem = new FakeTccFileSystem();
    fileSystem.error = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      executor: new FakeSqliteExecutor(),
      fileSystem,
      homeDirectory: "/Users/tester",
      environment: {
        [CORESIMULATOR_DEVICE_SET_PATH_ENV]: "/Volumes/CI/DeviceSets/job-7/Devices",
      },
    });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "Simulator TCC database is unavailable",
    );
    expect(fileSystem.paths).toEqual([
      join("/Volumes/CI/DeviceSets/job-7/Devices", DEVICE_ID, "data", "Library", "TCC", "TCC.db"),
    ]);
  });

  test("resolves the identical device set normalized for the child environment before chdir", async () => {
    // SimCtlClient inherits the normalized environment. This tests agreement
    // with the TCC reader, without invoking simctl or claiming toolchain support.
    const launchDirectory = resolve("launch-project");
    const environment = {
      [DAEMON_LAUNCH_CWD_ENV]: launchDirectory,
      [CORESIMULATOR_DEVICE_SET_PATH_ENV]: "custom-devices",
    };
    normalizeCoreSimulatorDeviceSetPathEnv(environment);
    const normalizedDeviceSetPath = environment[CORESIMULATOR_DEVICE_SET_PATH_ENV];
    expect(normalizedDeviceSetPath).toBe(join(launchDirectory, "custom-devices"));

    const fileSystem = new FakeTccFileSystem();
    fileSystem.error = Object.assign(new Error("absent"), { code: "ENOENT" });
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      executor: new FakeSqliteExecutor(),
      fileSystem,
      environment,
    });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "unavailable",
    );
    expect(fileSystem.paths).toEqual([
      join(normalizedDeviceSetPath, DEVICE_ID, "data", "Library", "TCC", "TCC.db"),
    ]);
  });

  test("classifies a locked/busy TCC database distinctly from a corrupted one", async () => {
    const executor = new FakeSqliteExecutor();
    const client = new SimulatorTccSqliteClient({
      timer: new FakeTimer(),
      environment: {},
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });

    executor.error = new Error("database is locked");
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      /locked|busy/i,
    );
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.not.toThrow(
      "Failed to read simulator TCC database",
    );

    executor.error = new Error("SQLITE_BUSY: database is busy");
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      /locked|busy/i,
    );
  });

  describe("readUserTrustedCertificates (#14828)", () => {
    const DATABASE = join(
      "/devices",
      DEVICE_ID,
      "data/private/var/protected/trustd/private/TrustStore.sqlite3",
    );

    function trustRig(response = "[]") {
      const executor = new FakeSqliteExecutor();
      executor.response = result(response);
      const fileSystem = new FakeTccFileSystem();
      const client = new SimulatorTccSqliteClient({
        timer: new FakeTimer(),
        executor,
        fileSystem,
        environment: {},
        deviceSetRoot: "/devices",
      });
      return { client, executor, fileSystem };
    }

    test("reads the user trust settings read-only from the simulator's trustd database", async () => {
      const { client, executor, fileSystem } = trustRig('[{"sha256":"ABCD"},{"sha256":"EF01"}]');
      const signal = new AbortController().signal;
      expect(await client.readUserTrustedCertificates(DEVICE_ID, signal)).toEqual([
        { sha256: "ABCD" },
        { sha256: "EF01" },
      ]);
      expect(fileSystem.paths).toEqual([DATABASE]);
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.file).toBe("sqlite3");
      expect(executor.calls[0]?.args).toEqual([
        "-readonly",
        "-json",
        DATABASE,
        "select hex(sha256) as sha256 from tsettings;",
      ]);
      expect(executor.calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    });

    test("an empty result set and an absent database both mean no trusted certificates", async () => {
      expect(await trustRig("").client.readUserTrustedCertificates(DEVICE_ID)).toEqual([]);
      const missing = trustRig();
      missing.fileSystem.error = Object.assign(new Error("gone"), { code: "ENOENT" });
      expect(await missing.client.readUserTrustedCertificates(DEVICE_ID)).toEqual([]);
      expect(missing.executor.calls).toEqual([]);
    });

    test("an unreadable database, a failed query and malformed output are errors, never an empty store", async () => {
      const denied = trustRig();
      denied.fileSystem.error = Object.assign(new Error("denied"), { code: "EACCES" });
      await expect(denied.client.readUserTrustedCertificates(DEVICE_ID)).rejects.toThrow(
        "Simulator trust store is unavailable",
      );
      const locked = trustRig();
      locked.executor.error = new Error("database is locked");
      await expect(locked.client.readUserTrustedCertificates(DEVICE_ID)).rejects.toThrow(/locked/);
      await expect(
        trustRig('[{"nope":1}]').client.readUserTrustedCertificates(DEVICE_ID),
      ).rejects.toThrow("without sha256");
      await expect(
        trustRig().client.readUserTrustedCertificates("physical-device"),
      ).rejects.toThrow("requires a simulator UDID");
    });
  });
});
