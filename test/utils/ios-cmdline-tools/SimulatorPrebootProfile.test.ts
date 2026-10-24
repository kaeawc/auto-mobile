import { NodeSimulatorHostState } from "../../../src/utils/ios-cmdline-tools/NodeSimulatorHostState";
import { expect, test, spyOn } from "bun:test";
import {
  SimulatorPrebootProfile,
  resolvePrebootLabels,
  resolveDefaultPrebootProfile,
  simulatorHostStateDir,
  simulatorDisabledDbPath,
} from "../../../src/utils/ios-cmdline-tools/SimulatorPrebootProfile";
import { FakeSimulatorHostState } from "../../fakes/FakeSimulatorHostState";
import { iosDeviceResourceCatalog as catalog } from "../../../src/utils/iosDeviceResourceCatalog";
import { logger } from "../../../src/utils/logger";

const UDID = "12345678-1234-ABCD-9876-123456789ABC";
function harness(profile: "none" | "minimal" | "catalog-cpu" = "none") {
  const host = new FakeSimulatorHostState();
  return { host, service: new SimulatorPrebootProfile(host, () => profile) };
}
test("resolves only catalog labels, with explicit overrides and sorted union", () => {
  expect(resolvePrebootLabels({ profile: "none" })).toEqual([]);
  expect(resolvePrebootLabels({ profile: "catalog-cpu" })).toHaveLength(23);
  expect(resolvePrebootLabels({ profile: "minimal" })).toEqual(
    [...catalog.wallpaperRendering, ...catalog.widgets, ...catalog.liveActivities].sort(),
  );
  expect(
    resolvePrebootLabels({
      profile: "minimal",
      resources: {
        widgets: "enabled",
        healthServices: "disabled",
        animations: "disabled",
      },
    }),
  ).toEqual(
    [...catalog.wallpaperRendering, ...catalog.liveActivities, ...catalog.healthServices].sort(),
  );
  expect(resolvePrebootLabels({ profile: "none", resources: { widgets: "disabled" } })).toEqual([
    ...catalog.widgets,
  ]);
});
test("host paths use the per-UDID CoreSimulator directory", () => {
  expect(simulatorHostStateDir(UDID)).toBe(
    `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${UDID}`,
  );
  expect(simulatorHostStateDir(UDID.toLowerCase())).toBe(simulatorHostStateDir(UDID));
  expect(simulatorDisabledDbPath(UDID.toLowerCase())).toBe(simulatorDisabledDbPath(UDID));
  expect(simulatorDisabledDbPath(UDID)).toBe(`${simulatorHostStateDir(UDID)}/disabled.plist`);
});
test.each(["../x", "A/B", "sim", `${UDID}/x`, `${UDID}\n`])(
  "invalid UDID %s cannot touch host state",
  async (udid) => {
    const { host, service } = harness("minimal");
    expect((await service.apply(udid, {})).applied).toBe(false);
    await service.removeHostState(udid);
    expect(host.calls).toEqual([]);
  },
);
test("none touches nothing", async () => {
  const { host, service } = harness();
  expect(await service.apply(UDID, {})).toEqual({ applied: false, labels: [] });
  expect(host.calls).toEqual([]);
});
test("creates a private directory and merges foreign keys into the binary database", async () => {
  const { host, service } = harness("minimal");
  host.existing = { foreign: false, nested: { untouched: true } };
  const result = await service.apply(UDID, {});
  expect(result).toEqual({
    applied: true,
    labels: resolvePrebootLabels({ profile: "minimal" }),
    path: simulatorDisabledDbPath(UDID),
  });
  expect(host.calls).toEqual([
    ["mkdir", simulatorHostStateDir(UDID)],
    ["read", simulatorDisabledDbPath(UDID)],
    ["write", simulatorDisabledDbPath(UDID)],
  ]);
  expect(host.written).toEqual({
    foreign: false,
    nested: { untouched: true },
    ...Object.fromEntries(result.labels.map((label) => [label, true])),
  });
});
test("write failures warn and return typed failure", async () => {
  const { host, service } = harness("minimal");
  host.writeError = new Error("denied");
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(await service.apply(UDID, {})).toMatchObject({ applied: false, reason: "denied" });
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
test("removes the right directory and tolerates missing directories", async () => {
  const { host, service } = harness();
  await service.removeHostState(UDID);
  expect(host.calls).toEqual([["rm", simulatorHostStateDir(UDID)]]);
  host.removeError = Object.assign(new Error("missing"), { code: "ENOENT" });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await service.removeHostState(UDID);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
test("unexpected remove failures warn without throwing", async () => {
  const { host, service } = harness();
  host.removeError = new Error("denied");
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await service.removeHostState(UDID);
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
test("environment defaults to none and accepts only named profiles", () => {
  expect(resolveDefaultPrebootProfile({})).toBe("none");
  for (const profile of ["none", "minimal", "catalog-cpu"] as const) {
    expect(resolveDefaultPrebootProfile({ AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE: profile })).toBe(
      profile,
    );
  }
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(
      resolveDefaultPrebootProfile({ AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE: "everything" }),
    ).toBe("none");
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("Node adapter uses private mkdir, PlistClient reads and an atomic binary write", async () => {
  const calls: unknown[][] = [];
  const files = {
    mkdir: async (path: string, options: object) => {
      calls.push(["mkdir", path, options]);
    },
    lstat: async (path: string) => {
      calls.push(["lstat", path]);
      return { isDirectory: () => true, isSymbolicLink: () => false, uid: 501 };
    },
    access: async (path: string) => {
      calls.push(["access", path]);
    },
    writeFile: async (path: string, contents: string, options: object) => {
      calls.push(["reserve", path, contents, options]);
    },
    rename: async (from: string, to: string) => {
      calls.push(["rename", from, to]);
    },
    rm: async (path: string, options: object) => {
      calls.push(["rm", path, options]);
    },
  };
  const plist = {
    readJsonFile: async () => ({ foreign: false }),
    writeBinaryFromJson: async (path: string, value: Record<string, unknown>) => {
      calls.push(["binary", path, value]);
    },
  };
  const host = new NodeSimulatorHostState(plist, files, { next: () => "unique" }, () => 501);
  await host.mkdirPrivate("/host");
  expect(await host.readExisting("/host/disabled.plist")).toEqual({ foreign: false });
  await host.writeBinaryPlist("/host/disabled.plist", { label: true });
  expect(calls).toEqual([
    ["mkdir", "/host", { recursive: true, mode: 0o700 }],
    ["lstat", "/host"],
    ["access", "/host/disabled.plist"],
    ["reserve", "/host/disabled.plist.unique.tmp", "", { mode: 0o600, flag: "wx" }],
    ["binary", "/host/disabled.plist.unique.tmp", { label: true }],
    ["rename", "/host/disabled.plist.unique.tmp", "/host/disabled.plist"],
    ["rm", "/host/disabled.plist.unique.tmp", { force: true }],
  ]);
});

test("evaluates the default lazily on each apply without reading ambient env in tests", async () => {
  const host = new FakeSimulatorHostState();
  const env: NodeJS.ProcessEnv = {};
  const service = new SimulatorPrebootProfile(host, () => resolveDefaultPrebootProfile(env));
  env.AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE = "minimal";
  expect((await service.apply(UDID, {})).labels).toHaveLength(3);
  host.calls.length = 0;
  env.AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE = "none";
  expect(await service.apply(UDID, {})).toEqual({ applied: false, labels: [] });
  expect(host.calls).toEqual([]);
});

test.each(["none", "minimal"] as const)(
  "aborted %s apply returns failure without host effects",
  async (profile) => {
    const { host, service } = harness(profile);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      expect(await service.apply(UDID, {}, controller.signal)).toMatchObject({
        applied: false,
        reason: "aborted",
      });
      expect(host.calls).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  },
);

test.each(["missing", "invalid", "write failure", "rename failure"])(
  "Node adapter preserves the database on %s",
  async (mode) => {
    const calls: string[] = [];
    const host = new NodeSimulatorHostState(
      {
        readJsonFile: async () => {
          calls.push("read");
          return [];
        },
        writeBinaryFromJson: async () => {
          calls.push("write");
          if (mode === "write failure") {
            throw new Error("write failed");
          }
        },
      },
      {
        mkdir: async () => {},
        lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 501 }),
        access: async () => {
          if (mode === "missing") {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
        },
        writeFile: async () => {},
        rename: async () => {
          calls.push("rename");
          if (mode === "rename failure") {
            throw new Error("rename failed");
          }
        },
        rm: async () => {
          calls.push("cleanup");
        },
      },
      { next: () => "unique" },
    );
    if (mode === "missing") {
      expect(await host.readExisting("/host/disabled.plist")).toEqual({});
      expect(calls).toEqual([]);
    } else if (mode === "invalid") {
      await expect(host.readExisting("/host/disabled.plist")).rejects.toThrow("dictionary");
    } else {
      await expect(host.writeBinaryPlist("/host/disabled.plist", {})).rejects.toThrow("failed");
      expect(calls).toEqual(
        mode === "write failure" ? ["write", "cleanup"] : ["write", "rename", "cleanup"],
      );
    }
  },
);

test.each(["symlink", "foreign owner", "file", "ok"])(
  "Node adapter validates the host directory before applying: %s",
  async (mode) => {
    const calls: string[] = [];
    const host = new NodeSimulatorHostState(
      {
        readJsonFile: async () => ({}),
        writeBinaryFromJson: async () => {
          calls.push("write");
        },
      },
      {
        mkdir: async () => {
          calls.push("mkdir");
        },
        lstat: async () => {
          calls.push("lstat");
          return {
            isDirectory: () => mode !== "file",
            isSymbolicLink: () => mode === "symlink",
            uid: mode === "foreign owner" ? 502 : 501,
          };
        },
        access: async () => {},
        writeFile: async () => {},
        rename: async () => {},
        rm: async () => {},
      },
      { next: () => "unique" },
      () => 501,
    );
    const service = new SimulatorPrebootProfile(host, () => "minimal");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect((await service.apply(UDID, {})).applied).toBe(mode === "ok");
      expect(calls).toEqual(mode === "ok" ? ["mkdir", "lstat", "write"] : ["mkdir", "lstat"]);
    } finally {
      warn.mockRestore();
    }
  },
);
