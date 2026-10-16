import { expect, test } from "bun:test";
import { z } from "zod";
import { join, resolve } from "node:path";
import {
  parsePmsetBatt,
  parsePmsetAssertions,
  parseIoregClamshell,
  parsePmsetSettings,
  buildHostPreflightReport,
  hostPreflight,
  type HostStats,
  type HostSections,
} from "../../scripts/manual-test/hostPreflight";
import {
  runPrivateDaemonCommand,
  parsePrivateDaemonArgs,
} from "../../scripts/manual-test/private-daemon";
import { fixture, options, parsed } from "./manualTestPrivateDaemonFixture";
// Read real host captures as immutable text assets, never through a spawned command.
const captures = await Promise.all(
  ["pmset-batt", "pmset-assertions", "ioreg-clamshell", "pmset-settings"].map(async (name) => {
    const asset: { default: unknown } = await import(
      new URL(`../fixtures/manual-test-host/${name}.txt`, import.meta.url).href,
      { with: { type: "text" } }
    );
    return z.string().parse(asset.default);
  }),
);
const stats: HostStats = {
  platform: "darwin",
  loadAverage: [1, 2, 3],
  cpuCount: 8,
  freeMemoryBytes: 10,
  totalMemoryBytes: 20,
};
const healthy: HostSections = {
  power: { source: "ac", chargePercent: 85 },
  sleep: { preventUserIdleSystemSleep: true, preventSystemSleep: true },
  lid: { closed: false, clamshellCausesSleep: false },
  lowPower: { enabled: false },
};
function darwinFixture() {
  const f = fixture();
  f.deps.hostStats = () => stats;
  f.deps.runCapture = async (command, args, env, timeoutMs) => {
    f.captures.push({ command, args, env, timeoutMs });
    return {
      exitCode: 0,
      stdout:
        captures[command === "ioreg" ? 2 : args.length === 1 ? 3 : args[1] === "batt" ? 0 : 1],
      stderr: "",
    };
  };
  return f;
}
test("parsers read real captures and only system-wide assertion counters", () => {
  expect(parsePmsetBatt(captures[0])).toEqual(healthy.power);
  expect(parsePmsetAssertions(captures[1])).toEqual(healthy.sleep);
  expect(parseIoregClamshell(captures[2])).toEqual(healthy.lid);
  expect(parsePmsetSettings(captures[3])).toEqual({ enabled: false });
  expect(
    buildHostPreflightReport(options.batchDir, stats, {
      ...healthy,
      lowPower: parsePmsetSettings(captures[3]),
    }).warnings,
  ).toEqual([]);
  expect(parsePmsetAssertions(captures[1].split("Listed by owning process:")[1])).toHaveProperty(
    "unavailable",
  );
});
test("low power mode warns only when reported enabled", () => {
  expect(parsePmsetSettings("lowpowermode         1")).toEqual({ enabled: true });
  expect(parsePmsetSettings("lowpowermode 0")).toEqual({ enabled: false });
  expect(parsePmsetSettings("powermode 1")).toEqual({ enabled: true });
  expect(parsePmsetSettings("powermode 0")).toEqual({ enabled: false });
  expect(parsePmsetSettings("lowpowermode 1\npowermode 2")).toEqual({ enabled: true });
  expect(parsePmsetSettings("lowpowermode 1 (x)\r\n")).toEqual({ enabled: true });
  expect(parsePmsetSettings("garbage")).toEqual({
    unavailable: "pmset lowpowermode or powermode setting not reported",
  });
  expect(
    buildHostPreflightReport(options.batchDir, stats, {
      ...healthy,
      lowPower: parsePmsetSettings("lowpowermode 0"),
    }).warnings,
  ).toEqual([]);
  expect(
    buildHostPreflightReport(options.batchDir, stats, {
      ...healthy,
      lowPower: parsePmsetSettings("lowpowermode         1"),
    }).warnings,
  ).toEqual([
    "Low Power Mode is on; timings are unreliable and the host may throttle; turn it off before the batch.",
  ]);
  expect(
    buildHostPreflightReport(options.batchDir, stats, {
      ...healthy,
      lowPower: parsePmsetSettings("powermode 1"),
    }).warnings,
  ).toEqual([
    "Low Power Mode is on; timings are unreliable and the host may throttle; turn it off before the batch.",
  ]);
  expect(
    buildHostPreflightReport(options.batchDir, stats, {
      ...healthy,
      lowPower: parsePmsetSettings("garbage"),
    }).warnings,
  ).toEqual([]);
});
test("garbage is unknown or unavailable without throwing", () => {
  expect(parsePmsetBatt("garbage")).toEqual({ source: "unknown" });
  expect(parsePmsetAssertions("garbage")).toHaveProperty("unavailable");
  expect(parseIoregClamshell("garbage")).toHaveProperty("unavailable");
});
test.each([
  ["unknown", { power: { source: "unknown" } }, "could not be determined"],
  ["battery", { power: { source: "battery", chargePercent: 12 } }, "12%"],
  [
    "idle",
    { sleep: { preventUserIdleSystemSleep: false, preventSystemSleep: false } },
    "caffeinate",
  ],
  ["lid", { lid: { closed: true } }, "open"],
  [
    "clamshell on battery",
    {
      power: { source: "battery", chargePercent: 50 },
      lid: { closed: false, clamshellCausesSleep: true },
    },
    "cannot prevent",
    2,
  ],
  [
    "clamshell with unknown power",
    { power: { source: "unknown" }, lid: { closed: false, clamshellCausesSleep: true } },
    "cannot prevent",
    2,
  ],
  [
    "clamshell with unavailable power",
    { power: { unavailable: "x" }, lid: { closed: false, clamshellCausesSleep: true } },
    "cannot prevent",
    2,
  ],
  [
    "closed lid on AC",
    { lid: { closed: true, clamshellCausesSleep: true } },
    "The lid is closed",
    1,
  ],
  ["unavailable", { power: { unavailable: "reader failed" } }, "reader failed"],
] satisfies Array<[string, Partial<HostSections>, string, number?]>)(
  "typed %s warning is actionable",
  (_name, sections, message, count = 1) => {
    const report = buildHostPreflightReport(options.batchDir, stats, { ...healthy, ...sections });
    expect(report.warnings).toHaveLength(count);
    expect(report.warnings.some((w) => w.includes(message))).toBe(true);
  },
);
test("clamshell warning is suppressed on AC with the lid open", () => {
  const report = buildHostPreflightReport(options.batchDir, stats, {
    ...healthy,
    lid: { closed: false, clamshellCausesSleep: true },
  });
  expect(report.warnings).toEqual([]);
});
test("high load warns; memory is report only; healthy and unsupported hosts do not warn", () => {
  expect(
    buildHostPreflightReport(options.batchDir, { ...stats, loadAverage: [17, 0, 0] }, healthy)
      .warnings,
  ).toHaveLength(1);
  expect(
    buildHostPreflightReport(options.batchDir, { ...stats, loadAverage: [16, 0, 0] }, healthy)
      .warnings,
  ).toEqual([]);
  expect(buildHostPreflightReport(options.batchDir, stats, healthy)).toMatchObject({
    warnings: [],
    freeMemoryBytes: 10,
    totalMemoryBytes: 20,
  });
});
test("non-darwin runs no command and reports unsupported sections", async () => {
  const f = fixture();
  f.deps.runCapture = async () => {
    throw new Error("must not run");
  };
  const report = await hostPreflight(options.batchDir, f.deps);
  expect(report).toMatchObject({
    power: { unavailable: "unsupported platform" },
    sleep: { unavailable: "unsupported platform" },
    lid: { unavailable: "unsupported platform" },
    lowPower: { unavailable: "unsupported platform" },
    warnings: [],
  });
});
test("darwin command argv and deadlines use the capture seam", async () => {
  const f = darwinFixture();
  expect((await hostPreflight(options.batchDir, f.deps)).warnings).toEqual([]);
  expect(f.captures.map(({ command, args, timeoutMs }) => [command, args, timeoutMs])).toEqual([
    ["pmset", ["-g", "batt"], 5000],
    ["pmset", ["-g", "assertions"], 5000],
    ["ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"], 5000],
    ["pmset", ["-g"], 5000],
  ]);
});
test("preflight requires only a safe path, prints one document, strict reflects warnings", async () => {
  const f = darwinFixture();
  const command = parsed(["preflight", "--batch-dir", options.batchDir, "--strict"]);
  expect(await runPrivateDaemonCommand(command, f.deps)).toBe(0);
  expect(f.logs).toHaveLength(1);
  expect(f.files.size).toBe(0);
  f.deps.runCapture = async () => ({ exitCode: 1, stdout: "", stderr: "probe failed" });
  f.logs.length = 0;
  expect(await runPrivateDaemonCommand(command, f.deps)).toBe(1);
  expect(f.logs).toHaveLength(1);
  expect(JSON.parse(f.logs[0]).warnings).toHaveLength(3);
  expect(
    await runPrivateDaemonCommand(parsed(["preflight", "--batch-dir", options.batchDir]), f.deps),
  ).toBe(0);
});
test("caffeinate shell-quotes spaces and apostrophes", () => {
  expect(buildHostPreflightReport("/batch's space", stats, healthy).caffeinate).toBe(
    "nohup caffeinate -dims > /dev/null 2>&1 & echo $! > '/batch'\\''s space'/shared/caffeinate.pid",
  );
});
test("preflight guards the path before any reader", async () => {
  const f = fixture();
  expect(parsePrivateDaemonArgs(["preflight", "--strict"])).toHaveProperty("error");
  expect(
    parsePrivateDaemonArgs(["preflight", "--batch-dir", "/batch", "--daemon", "1"]),
  ).toHaveProperty("error");
  for (const batchDir of ["relative", resolve("/home/fake/.auto-mobile")]) {
    expect(
      await runPrivateDaemonCommand({ op: "preflight", batchDir, strict: false }, f.deps),
    ).toBe(2);
  }
  expect(f.captures).toEqual([]);
});
test.each(["reject", "nonzero"])(
  "init/start preserve output and exit codes with %s readers",
  async (kind) => {
    const f = darwinFixture();
    f.deps.runCapture = async () => {
      if (kind === "reject") {
        throw new Error("host read failed");
      }
      return { exitCode: 1, stdout: "", stderr: "host read failed" };
    };
    expect(await runPrivateDaemonCommand({ op: "init", options }, f.deps)).toBe(0);
    const path = join(options.batchDir, "shared/preflight-0.json");
    expect(JSON.parse(f.files.get(path)!).warnings).toHaveLength(3);
    expect(f.dirs).toContainEqual([join(options.batchDir, "shared"), 0o700]);
    expect(f.logs.filter((line) => line.startsWith("PREFLIGHT WARNING: "))).toHaveLength(3);
    expect(f.logs.at(-1)).toContain("nohup caffeinate -dims");
    f.logs.length = 0;
    expect(
      await runPrivateDaemonCommand(parsed(["start", "--batch-dir", options.batchDir]), f.deps),
    ).toBe(0);
    expect(f.writes.filter((p) => p === path)).toHaveLength(2);
    expect(f.logs.filter((line) => line.startsWith("PREFLIGHT WARNING: "))).toHaveLength(3);
    expect(JSON.parse(f.logs.at(-1)!)).toMatchObject({ name: "P2", pid: 1234 });
    f.deps.runCommand = async () => ({ exitCode: 7 });
    expect(
      await runPrivateDaemonCommand(parsed(["start", "--batch-dir", options.batchDir]), f.deps),
    ).toBe(7);
  },
);
test("preflight write and hostStats failures never fail init/start", async () => {
  const f = fixture();
  f.deps.hostStats = () => {
    throw new Error("stats failed");
  };
  expect(await runPrivateDaemonCommand({ op: "init", options }, f.deps)).toBe(0);
  expect(f.logs.at(-1)).toContain("PREFLIGHT WARNING:");
  f.deps.hostStats = () => stats;
  const write = f.deps.writeFile;
  f.deps.writeFile = (path, text) => {
    if (path.includes("preflight-")) {
      throw new Error("record failed");
    }
    write(path, text);
  };
  expect(
    await runPrivateDaemonCommand(parsed(["start", "--batch-dir", options.batchDir]), f.deps),
  ).toBe(0);
  expect(f.logs.some((line) => line.includes("record failed"))).toBe(true);
});
