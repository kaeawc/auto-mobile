import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DEFAULT_DAEMON_PORT } from "../../src/daemon/constants";
import {
  derivePrivateDaemonBatch,
  privateDaemonBatchRefusal,
  renderEnvFile,
  DERIVED_PATH_VARIABLES,
  privateClientEnvironment,
  type PrivateDaemonBatchOptions,
  canonicalizePath,
  privatePathRefusal,
  INHERITED_ENV_VARIABLES,
  type CanonicalizePathFs,
} from "../../scripts/manual-test/privateDaemonEnv";
import { privateHarnessEnvRefusal } from "../../scripts/manual-test/harnessEnv";
import { resolveAutoMobileBaseDir } from "../../src/utils/tempDir";

const posixTest = process.platform === "win32" ? test.skip : test;
function memoryFs(
  entries: Record<string, { realpath?: string; error?: string; target?: string }>,
): CanonicalizePathFs {
  const failure = (code: string): Error => Object.assign(new Error(code), { code });
  return {
    realpath(path) {
      const entry = entries[path];
      if (!entry || entry.error) {
        throw failure(entry?.error ?? "ENOENT");
      }
      return entry.realpath ?? path;
    },
    lstat(path) {
      const entry = entries[path];
      if (!entry) {
        throw failure("ENOENT");
      }
      return { isSymbolicLink: () => entry.target !== undefined };
    },
    readlink(path) {
      const target = entries[path]?.target;
      if (target === undefined) {
        throw failure("EINVAL");
      }
      return target;
    },
  };
}
posixTest("canonicalizePath uses the realpath result for an existing path", () => {
  const fs = memoryFs({ "/alias/file": { realpath: "/canonical/file" } });
  expect(canonicalizePath(" /alias/file ", fs)).toBe("/canonical/file");
});
posixTest("canonicalizePath canonicalizes a socket's aliased parent", () => {
  const fs = memoryFs({
    "/tmp": { realpath: "/private/tmp" },
    "/tmp/d.sock": { error: "EOPNOTSUPP" },
  });
  expect(canonicalizePath("/tmp/d.sock", fs)).toBe("/private/tmp/d.sock");
});
posixTest("canonicalizePath joins missing descendants to the deepest existing ancestor", () => {
  const fs = memoryFs({ "/alias": { realpath: "/canonical" } });
  expect(canonicalizePath("/alias/missing/leaf", fs)).toBe("/canonical/missing/leaf");
  const notDirectory = memoryFs({
    "/alias": { realpath: "/canonical" },
    "/alias/file/leaf": { error: "ENOTDIR" },
  });
  expect(canonicalizePath("/alias/file/leaf", notDirectory)).toBe("/canonical/file/leaf");
});
posixTest("canonicalizePath follows dangling links into default roots and refuses them", () => {
  for (const target of ["../home/fake/.auto-mobile/missing", "/home/fake/.auto-mobile/missing"]) {
    const fs = memoryFs({
      "/": {},
      "/alias": { realpath: "/canonical" },
      "/alias/link": { error: "ENOENT", target },
    });
    expect(canonicalizePath("/alias/link", fs)).toBe("/home/fake/.auto-mobile/missing");
    expect(
      privatePathRefusal("/alias/link", {
        ...host,
        canonicalize: (path) => canonicalizePath(path, fs),
      }),
    ).toContain("default product");
  }
});
posixTest("canonicalizePath fails closed for ELOOP", () => {
  const fs = memoryFs({ "/loop": { error: "ELOOP" } });
  expect(() => canonicalizePath("/loop", fs)).toThrow("ELOOP");
});
posixTest("canonicalizePath bounds dangling symlink resolution", () => {
  const entries: Parameters<typeof memoryFs>[0] = { "/": {} };
  for (let index = 0; index < 9; index++) {
    entries[`/link${index}`] = { error: "ENOENT", target: `/link${index + 1}` };
  }
  const fs = memoryFs(entries);
  expect(() => canonicalizePath("/link0", fs)).toThrow("depth");
  expect(canonicalizePath("/link1", fs)).toBe("/link9");
});
posixTest("canonicalizePath propagates unreadable metadata and unreadable symlink targets", () => {
  const fs = memoryFs({ "/": {}, "/link": { error: "ENOENT", target: "/missing" } });
  expect(() =>
    canonicalizePath("/link", {
      ...fs,
      lstat: () => {
        throw new Error("lstat denied");
      },
    }),
  ).toThrow("lstat denied");
  expect(() =>
    canonicalizePath("/link", {
      ...fs,
      readlink: () => {
        throw new Error("readlink denied");
      },
    }),
  ).toThrow("readlink denied");
});
posixTest(
  "path, batch and client refusals report canonicalization errors with the failing path",
  () => {
    for (const failure of ["candidate", "root", "resident"]) {
      let failingPath = "";
      const failingHost = {
        ...host,
        homeDirs: failure === "resident" ? [] : host.homeDirs,
        canonicalize(path: string) {
          if (
            (failure === "candidate" && path === options.batchDir) ||
            (failure === "root" && path === "/home/fake/.auto-mobile") ||
            (failure === "resident" && path.endsWith(".sock"))
          ) {
            failingPath = path;
            throw new Error(`EACCES at ${path}`);
          }
          return resolve(path);
        },
      };
      const specs = derivePrivateDaemonBatch(options);
      const messages = [
        privatePathRefusal(options.batchDir, failingHost),
        privateDaemonBatchRefusal(specs, options, failingHost),
        privateHarnessEnvRefusal(
          { ...specs[0].env, AUTOMOBILE_DATA_DIR: options.batchDir },
          failingHost,
        ),
      ];
      for (const message of messages) {
        expect(message).toContain("Refusing");
        expect(message).toContain("EACCES");
        expect(failingPath).not.toBe("");
        expect(message).toContain(failingPath);
      }
    }
  },
);
posixTest("env file uses POSIX unset lines for the shared inherited names", () => {
  expect(INHERITED_ENV_VARIABLES).toEqual([
    ...DERIVED_PATH_VARIABLES.map((key) => key.replace("AUTOMOBILE_", "AUTO_MOBILE_")),
    "AUTOMOBILE_DB_PATH",
    "AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH",
    "AUTO_MOBILE_DB_PATH",
    "AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH",
    "AUTOMOBILE_MANAGED_SLOT_CONFIG",
  ]);
  const envFile = renderEnvFile(derivePrivateDaemonBatch(options)[0], options);
  expect(envFile).not.toContain("${!");
  for (const key of INHERITED_ENV_VARIABLES) {
    expect(envFile).toContain(`unset ${key}\n`);
    expect(privateClientEnvironment({ [key]: "inherited" }, {})).toEqual({});
    expect(refusal({ extraEnv: { [key]: "override" } })).toContain("may not override");
  }
});
const host = {
  homeDirs: [resolve("/home/fake"), resolve("/home/other-fake")],
  uid: 4242,
  canonicalize: resolve,
};
const options: PrivateDaemonBatchOptions = {
  batchDir: resolve("/evidence/batch"),
  count: 2,
  basePort: 3160,
  auxRoot: resolve("/mt-aux"),
  serverPath: resolve("/built/index.js"),
};
function refusal(changes: Partial<PrivateDaemonBatchOptions>): string | undefined {
  const modified = { ...options, ...changes };
  return privateDaemonBatchRefusal(derivePrivateDaemonBatch(modified), modified, host);
}
posixTest("derives two isolated daemons with one shared ADB registry", () => {
  const specs = derivePrivateDaemonBatch(options);
  expect(specs.map((spec) => spec.port)).toEqual([3160, 3161]);
  expect(specs.map((spec) => spec.name)).toEqual(["P1", "P2"]);
  expect(specs[0].dir).toBe(join(options.batchDir, "daemon1"));
  expect(specs[0].dir).not.toBe(specs[1].dir);
  expect(specs[0].auxSocketDir).not.toBe(specs[1].auxSocketDir);
  expect(specs[0].adbServerCoordinationDir).toBe(join(options.batchDir, "shared", "adb-servers"));
  expect(specs[0].adbServerCoordinationDir).toBe(specs[1].adbServerCoordinationDir);
  for (const spec of specs) {
    for (const key of DERIVED_PATH_VARIABLES) {
      expect(spec.env[key]).toBeDefined();
    }
    expect(spec.env.AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS).toBe("0");
    expect(spec.env.AUTOMOBILE_APPEARANCE_SYNC).toBe("off");
    expect(spec.env.MT_SERVER).toBe(options.serverPath);
    expect(spec.env.MT_BATCH).toBe(options.batchDir);
    expect(spec.env.MT_DAEMON).toBe(spec.name);
    expect(spec.env.MT_PORT).toBe(String(spec.port));
  }
});
posixTest("split mode deliberately separates ADB registries", () => {
  const specs = derivePrivateDaemonBatch({ ...options, splitAdbCoordination: true });
  expect(specs[0].adbServerCoordinationDir).toBe(join(specs[0].dir, "adb-servers"));
  expect(specs[0].adbServerCoordinationDir).not.toBe(specs[1].adbServerCoordinationDir);
});
posixTest("clean batch passes and default aux root is a short batch hash", () => {
  expect(refusal({})).toBeUndefined();
  const specs = derivePrivateDaemonBatch({ ...options, auxRoot: undefined });
  expect(specs[0].auxSocketDir).toMatch(/^\/tmp\/am-mt-[a-f0-9]{8}\/1$/);
  expect(specs[0].auxSocketDir).not.toBe(
    derivePrivateDaemonBatch({ ...options, auxRoot: undefined, batchDir: "/another" })[0]
      .auxSocketDir,
  );
});
posixTest("refuses either fake home's default state and default aux root", () => {
  for (const home of host.homeDirs) {
    const base = resolveAutoMobileBaseDir({}, home, options.batchDir);
    expect(refusal({ batchDir: join(base, "batch") })).toContain("default product");
    expect(refusal({ auxRoot: base })).toContain("default product");
  }
});
posixTest(
  "refuses relative paths, invalid count/ports, resident port, and long socket paths",
  () => {
    for (const key of ["batchDir", "auxRoot", "serverPath"]) {
      expect(refusal({ [key]: "relative" })).toContain("absolute");
    }
    for (const count of [0, 9, 1.5]) {
      expect(refusal({ count })).toContain("count");
    }
    for (const basePort of [0, 65535, 1.5]) {
      expect(refusal({ basePort })).toContain("ports");
    }
    expect(refusal({ basePort: DEFAULT_DAEMON_PORT })).toContain("DEFAULT_DAEMON_PORT");
    expect(refusal({ auxRoot: resolve(`/${"long".repeat(30)}`) })).toContain("103 bytes");
    const specs = derivePrivateDaemonBatch(options);
    specs[1].port = specs[0].port;
    expect(privateDaemonBatchRefusal(specs, options, host)).toContain("distinct");
  },
);
posixTest("refuses protected env overrides and quotes shell values", () => {
  for (const key of [
    ...DERIVED_PATH_VARIABLES,
    ...DERIVED_PATH_VARIABLES.map((key) => key.replace("AUTOMOBILE_", "AUTO_MOBILE_")),
    "MT_BATCH",
    "MT_DAEMON",
    "MT_SERVER",
    "MT_PORT",
    "AUTOMOBILE_DB_PATH",
    "AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH",
    "AUTO_MOBILE_DB_PATH",
    "AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH",
    "AUTOMOBILE_MANAGED_SLOT_CONFIG",
  ]) {
    expect(refusal({ extraEnv: { [key]: "/override" } })).toContain("may not override");
  }
  const modified = { ...options, extraEnv: { NOTE: "a space and 'quote'" } };
  const spec = derivePrivateDaemonBatch(modified)[0];
  expect(renderEnvFile(spec, modified)).toContain("export NOTE='a space and '\\''quote'\\'''\n");
  expect(renderEnvFile(spec, modified)).toContain("unset AUTOMOBILE_MANAGED_SLOT_CONFIG\n");
});
posixTest("private harness guard requires both private paths and server", () => {
  const env = derivePrivateDaemonBatch(options)[0].env;
  expect(privateHarnessEnvRefusal(env, host)).toBeUndefined();
  for (const key of ["AUTOMOBILE_AUX_SOCKET_DIR", "AUTOMOBILE_DAEMON_SOCKET_PATH", "MT_SERVER"]) {
    expect(privateHarnessEnvRefusal({ ...env, [key]: "" }, host)).toBeDefined();
  }
  expect(
    privateHarnessEnvRefusal({ ...env, AUTOMOBILE_AUX_SOCKET_DIR: "relative" }, host),
  ).toBeDefined();
  expect(
    privateHarnessEnvRefusal(
      { ...env, AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/auto-mobile-daemon-4242.sock" },
      host,
    ),
  ).toContain("resident");
  expect(
    privateHarnessEnvRefusal(
      {
        ...env,
        AUTOMOBILE_AUX_SOCKET_DIR: resolveAutoMobileBaseDir({}, host.homeDirs[0], options.batchDir),
      },
      host,
    ),
  ).toContain("default product");
});

posixTest("private harness guard rejects whitespace-wrapped default paths", () => {
  const env = derivePrivateDaemonBatch(options)[0].env;
  expect(
    privateHarnessEnvRefusal(
      { ...env, AUTOMOBILE_DAEMON_SOCKET_PATH: " /tmp/auto-mobile-daemon-4242.sock " },
      host,
    ),
  ).toContain("resident");
  expect(
    privateHarnessEnvRefusal(
      { ...env, AUTOMOBILE_AUX_SOCKET_DIR: " /home/fake/.auto-mobile " },
      host,
    ),
  ).toContain("default product");
});

posixTest(
  "client refuses partial env, every missing path, aliases, overrides and default data",
  () => {
    const env = derivePrivateDaemonBatch(options)[0].env;
    expect(
      privateHarnessEnvRefusal(
        {
          AUTOMOBILE_AUX_SOCKET_DIR: env.AUTOMOBILE_AUX_SOCKET_DIR,
          AUTOMOBILE_DAEMON_SOCKET_PATH: env.AUTOMOBILE_DAEMON_SOCKET_PATH,
          MT_SERVER: env.MT_SERVER,
        },
        host,
      ),
    ).toBeDefined();
    expect(privateHarnessEnvRefusal(env, host)).toBeUndefined();
    for (const key of Object.keys(env).filter(
      (key) => key.startsWith("AUTOMOBILE_") && (key.endsWith("DIR") || key.endsWith("PATH")),
    )) {
      expect(privateHarnessEnvRefusal({ ...env, [key]: undefined }, host)).toBeDefined();
      expect(privateHarnessEnvRefusal({ ...env, [key]: "relative" }, host)).toBeDefined();
    }
    for (const key of [
      "AUTO_MOBILE_DATA_DIR",
      "AUTO_MOBILE_AUX_SOCKET_DIR",
      "AUTOMOBILE_DB_PATH",
      "AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH",
    ]) {
      expect(privateHarnessEnvRefusal({ ...env, [key]: "/elsewhere" }, host)).toBeDefined();
    }
    expect(
      privateHarnessEnvRefusal(
        { ...env, AUTOMOBILE_DATA_DIR: "/home/fake/.auto-mobile/child" },
        host,
      ),
    ).toContain("default product");
  },
);
test("client environment strips all inherited legacy spellings and path overrides", () => {
  const inherited = {
    AUTO_MOBILE_DATA_DIR: "legacy",
    AUTO_MOBILE_AUX_SOCKET_DIR: "legacy",
    AUTO_MOBILE_LOG_DIR: "legacy",
    AUTO_MOBILE_FUTURE_PATH: "legacy",
    AUTOMOBILE_DB_PATH: "override",
    AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH: "override",
    KEEP: "yes",
  };
  expect(privateClientEnvironment(inherited, { AUTOMOBILE_DATA_DIR: "derived" })).toEqual({
    KEEP: "yes",
    AUTOMOBILE_DATA_DIR: "derived",
  });
});
posixTest(
  "client and batch refuse canonical resident paths and resident basenames anywhere",
  () => {
    const canonicalHost = {
      ...host,
      canonicalize: (path: string) => resolve(path.replace(/^\/private\/tmp(?=\/|$)/, "/tmp")),
    };
    const env = derivePrivateDaemonBatch(options)[0].env;
    for (const [key, ext] of [
      ["AUTOMOBILE_DAEMON_SOCKET_PATH", "sock"],
      ["AUTOMOBILE_DAEMON_PID_FILE_PATH", "pid"],
      ["AUTOMOBILE_DAEMON_LOCK_FILE_PATH", "lock"],
    ]) {
      for (const dir of ["/private/tmp", "/different"]) {
        const value = `${dir}/auto-mobile-daemon-4242.${ext}`;
        expect(privateHarnessEnvRefusal({ ...env, [key]: value }, canonicalHost)).toContain(
          "resident",
        );
        const specs = derivePrivateDaemonBatch(options);
        specs[0].env[key] = value;
        expect(privateDaemonBatchRefusal(specs, options, canonicalHost)).toContain("resident");
      }
    }
    const symlinkHost = {
      ...host,
      canonicalize: (path: string) =>
        resolve(path.replace(/^\/aliased-home(?=\/|$)/, "/home/fake")),
    };
    expect(
      privateHarnessEnvRefusal(
        { ...env, AUTOMOBILE_DATA_DIR: "/aliased-home/.auto-mobile/data" },
        symlinkHost,
      ),
    ).toContain("default product");
  },
);
