import { describe, expect, test } from "bun:test";
import { checkIosNetworkFilter } from "../../src/doctor/checks/ios";
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

function deps(status: NetworkFilterHostStatus | Error, platform: NodeJS.Platform = "darwin") {
  const timeouts: Array<number | undefined> = [];
  return {
    timeouts,
    value: {
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

  test("approval required warns with the System Settings steps", async () => {
    const result = await checkIosNetworkFilter(
      deps({
        ...INSTALLED,
        report: {
          state: "approval_required",
          controllerState: "approval_required",
          detail: "Approve it",
          nextSteps: NETWORK_FILTER_APPROVAL_STEPS,
        },
      }).value,
    );
    expect(result).toMatchObject({ status: "warn", value: "approval_required" });
    expect(result.recommendation).toBe(NETWORK_FILTER_APPROVAL_STEPS);
  });

  test("an unavailable provider warns with the activate hint", async () => {
    const result = await checkIosNetworkFilter(
      deps({
        ...INSTALLED,
        report: { state: "unavailable", controllerState: "unavailable", detail: "XPC failed" },
      }).value,
    );
    expect(result).toMatchObject({ status: "warn", value: "unavailable", detail: "XPC failed" });
    expect(result.recommendation).toContain(NETWORK_FILTER_INSTALL_COMMAND);
  });

  test("an inspector failure warns instead of throwing", async () => {
    const { value } = deps(new Error("boom"));
    const result = await checkIosNetworkFilter(value);
    expect(result.status).toBe("warn");
    expect(value.logger.at("warn").length).toBeGreaterThan(0);
  });

  test("skips off macOS and when no inspector is configured", async () => {
    expect((await checkIosNetworkFilter(deps(INSTALLED, "linux").value)).status).toBe("skip");
    const { platform, logger } = deps(INSTALLED).value;
    expect((await checkIosNetworkFilter({ platform, logger })).status).toBe("skip");
  });
});
