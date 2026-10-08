import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { checkIosNetworkFilter } from "../../src/doctor/checks/ios";
import { parseMdmEnrollment } from "../../src/doctor/checks/macMdmEnrollment";
import type { NetworkFilterHostStatus } from "../../src/features/networkFilter/NetworkFilterInstaller";
import {
  NETWORK_FILTER_APPROVAL_STEPS,
  NETWORK_FILTER_INSTALL_COMMAND,
} from "../../src/features/networkFilter/networkFilterApp";
import { FakeLogger } from "../fakes/FakeLogger";

const INSTALLED: NetworkFilterHostStatus = {
  installed: true,
  installedPath: "/Applications/AutoMobile Network Identity Probe.app",
  installedVersion: "0.0.90",
  expectedVersion: "0.0.90",
  report: { state: "ready", controllerState: "ready", detail: "Allow-only provider replied" },
};

// Real `profiles status -type enrollment` capture from an unenrolled Mac.
const NOT_ENROLLED = readFileSync(
  new URL("../fixtures/macos-profiles/enrollment-not-enrolled.txt", import.meta.url),
  "utf8",
);
// Not a capture (the capture host is unenrolled): the documented enrolled shape of the same command.
const ENROLLED = "Enrolled via DEP: Yes\nMDM enrollment: Yes (User Approved)\n";

function execReturning(stdout: string | Error) {
  const calls: Array<[string, string[]]> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const execFile = async (
    file: string,
    args: string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => {
    calls.push([file, args]);
    signals.push(options?.signal);
    if (stdout instanceof Error) {
      throw stdout;
    }
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (s: string) => stdout.includes(s),
    };
  };
  return { calls, signals, execFile };
}

function deps(
  status: NetworkFilterHostStatus | Error,
  platform: NodeJS.Platform = "darwin",
  enrollment: string | Error = NOT_ENROLLED,
) {
  const timeouts: Array<number | undefined> = [];
  const exec = execReturning(enrollment);
  return {
    timeouts,
    exec,
    value: {
      execFile: exec.execFile,
      platform: () => platform,
      logger: new FakeLogger(),
      networkFilterInspector: {
        inspect: async (options?: { timeoutMs?: number }) => {
          timeouts.push(options?.timeoutMs);
          if (status instanceof Error) {
            throw status;
          }
          return status;
        },
      },
    },
  };
}

const APPROVAL_REQUIRED: NetworkFilterHostStatus = {
  ...INSTALLED,
  report: {
    state: "approval_required",
    controllerState: "approval_required",
    detail: "Approve it",
    nextSteps: NETWORK_FILTER_APPROVAL_STEPS,
  },
};
const UNAVAILABLE: NetworkFilterHostStatus = {
  ...INSTALLED,
  report: { state: "unavailable", controllerState: "unavailable", detail: "XPC failed" },
};

describe("parseMdmEnrollment", () => {
  test("the unenrolled capture is not enrolled", () => {
    expect(parseMdmEnrollment(NOT_ENROLLED)).toEqual({ enrolled: false });
  });

  test("only an active MDM enrollment counts as enrolled; DEP assignment alone does not", () => {
    expect(parseMdmEnrollment(ENROLLED).enrolled).toBe(true);
    expect(parseMdmEnrollment("Enrolled via DEP: No\nMDM enrollment: Yes\n").enrolled).toBe(true);
    expect(parseMdmEnrollment("Enrolled via DEP: Yes\nMDM enrollment: No\n").enrolled).toBe(false);
  });

  test("empty output is not enrolled", () => {
    expect(parseMdmEnrollment("").enrolled).toBe(false);
  });
});

describe("checkIosNetworkFilter", () => {
  test("ready passes and forwards the probe timeout", async () => {
    const { value, timeouts } = deps(INSTALLED);
    const result = await checkIosNetworkFilter(value, { timeoutMs: 700 });
    expect(result).toMatchObject({ status: "pass", value: "ready" });
    expect(timeouts).toEqual([700]);
  });

  test("not installed is an optional skip with the install command", async () => {
    const result = await checkIosNetworkFilter(
      deps({ ...INSTALLED, installed: false, installedVersion: null, report: null }).value,
    );
    expect(result).toMatchObject({ status: "skip", value: "not_installed" });
    expect(result.detail).toContain(NETWORK_FILTER_INSTALL_COMMAND);
  });

  test("a version mismatch warns with the upgrade command", async () => {
    const result = await checkIosNetworkFilter(
      deps({ ...INSTALLED, installedVersion: "0.0.89" }).value,
    );
    expect(result).toMatchObject({ status: "warn", value: "version_mismatch" });
    expect(result.recommendation).toContain("--upgrade");
  });

  test("approval required on an unenrolled Mac keeps the steps and adds one MDM line", async () => {
    const result = await checkIosNetworkFilter(deps(APPROVAL_REQUIRED).value);
    expect(result).toMatchObject({ status: "warn", value: "approval_required" });
    expect(result.recommendation).toStartWith(NETWORK_FILTER_APPROVAL_STEPS);
    expect(result.recommendation).toContain("Managed Macs can pre-approve it via MDM");
    expect(result.recommendation).not.toContain("mobileconfig");
  });

  for (const [label, status] of [
    ["approval_required", APPROVAL_REQUIRED],
    ["unavailable", UNAVAILABLE],
  ] as const) {
    test(`${label} on an MDM-enrolled Mac points to the managed-Macs page and profile`, async () => {
      const { value, exec } = deps(status, "darwin", ENROLLED);
      const result = await checkIosNetworkFilter(value);
      expect(exec.calls).toEqual([["profiles", ["status", "-type", "enrollment"]]]);
      expect(result.value).toBe(label);
      expect(result.recommendation).toContain(
        "https://kaeawc.github.io/auto-mobile/using/managed-macs/",
      );
      expect(result.recommendation).toContain("automobile-network-filter.mobileconfig");
    });
  }

  test("unavailable on an unenrolled Mac keeps the activate hint and adds the MDM line", async () => {
    const result = await checkIosNetworkFilter(deps(UNAVAILABLE).value);
    expect(result).toMatchObject({ status: "warn", value: "unavailable", detail: "XPC failed" });
    expect(result.recommendation).toContain(NETWORK_FILTER_INSTALL_COMMAND);
    expect(result.recommendation).toContain("Managed Macs can pre-approve it via MDM");
    expect(result.recommendation).not.toContain("mobileconfig");
  });

  test("the enrollment subprocess receives the probe abort signal", async () => {
    const { value, exec } = deps(APPROVAL_REQUIRED, "darwin", ENROLLED);
    const controller = new AbortController();
    await checkIosNetworkFilter(value, { signal: controller.signal });
    expect(exec.signals).toEqual([controller.signal]);
  });

  test("a failing enrollment probe falls back to the unmanaged hint", async () => {
    const { value } = deps(APPROVAL_REQUIRED, "darwin", new Error("profiles missing"));
    const result = await checkIosNetworkFilter(value);
    expect(result.recommendation).toContain("Managed Macs can pre-approve it via MDM");
    expect(result.recommendation).not.toContain("mobileconfig");
    expect(value.logger.at("debug").length).toBeGreaterThan(0);
  });

  test("enrollment is not probed when the filter is not waiting on approval", async () => {
    const { value, exec } = deps(INSTALLED, "darwin", ENROLLED);
    await checkIosNetworkFilter(value);
    expect(exec.calls).toEqual([]);
  });

  test("an inspector failure warns instead of throwing", async () => {
    const { value } = deps(new Error("boom"));
    const result = await checkIosNetworkFilter(value);
    expect(result.status).toBe("warn");
    expect(value.logger.at("warn").length).toBeGreaterThan(0);
  });

  test("skips off macOS and when no inspector is configured", async () => {
    expect((await checkIosNetworkFilter(deps(INSTALLED, "linux").value)).status).toBe("skip");
    const { platform, logger, execFile } = deps(INSTALLED).value;
    expect((await checkIosNetworkFilter({ platform, logger, execFile })).status).toBe("skip");
  });
});
