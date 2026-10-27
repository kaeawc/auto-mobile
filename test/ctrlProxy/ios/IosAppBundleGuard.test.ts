import { describe, expect, spyOn, test, afterEach, mock } from "bun:test";
import { DefaultIosAppBundleGuard } from "../../../src/ctrlProxy/ios/IosAppBundleGuard";
import { logger } from "../../../src/utils/logger";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const APP_BUNDLE_ID = "dev.jasonpearson.automobile.ctrlproxy";

const LEGACY_APP_BUNDLE_ID = "dev.jasonpearson.automobile.XCTestServiceApp";

describe("IosAppBundleGuard", () => {
  for (const [deviceId, simulator] of [
    ["A1B2C3D4-E5F6-7890-ABCD-EF1234567890", true],
    ["00008030-001C2D3E1234567A", false],
  ] as const) {
    for (const [method, bundleId] of [
      ["uninstallLegacyAppIfPresent", LEGACY_APP_BUNDLE_ID],
      ["verifyInstalledAppBundle", APP_BUNDLE_ID],
    ] as const) {
      for (const fails of [false, true]) {
        test(`${method} on ${simulator ? "simulator" : "physical"} skips termination${fails ? " and swallows uninstall failure" : ""}`, async () => {
          const executor = new FakeProcessExecutor();
          const uninstalls: unknown[][] = [];
          const lookups: unknown[][] = [];
          const failure = new Error("uninstall failed");
          const appManager = {
            getInstalledAppBundleHash: async (...args: unknown[]) => {
              lookups.push(args);
              return "installed-hash";
            },
            uninstallApp: async (...args: unknown[]) => {
              uninstalls.push(args);
              if (fails) {
                throw failure;
              }
            },
          };
          const guard = new DefaultIosAppBundleGuard({
            device: { deviceId, platform: "ios", name: "iPhone" },
            deviceAppManager: appManager,
            processExecutor: executor,
            timer: new FakeTimer(),
            appBundleId: APP_BUNDLE_ID,
            legacyAppBundleId: LEGACY_APP_BUNDLE_ID,
            isSimulator: () => simulator,
            isHashVerificationSkipped: () => false,
            getExpectedAppHash: () => "expected-hash",
          });
          const warn = spyOn(logger, "warn").mockImplementation(() => {});
          try {
            await guard[method]();
            expect(uninstalls).toHaveLength(1);
            expect(uninstalls[0].slice(0, 3)).toEqual([deviceId, bundleId, simulator]);
            expect(uninstalls[0][3]).toBeUndefined();
            expect(lookups[0].slice(0, 3)).toEqual([deviceId, bundleId, simulator]);
            expect(executor.getExecutedCommands()).toEqual([]);
            expect(executor.getSpawnedProcesses()).toEqual([]);
            if (fails) {
              expect(
                warn.mock.calls.some(([message]) => String(message).includes("uninstall failed")),
              ).toBe(true);
            }
            if (method === "uninstallLegacyAppIfPresent") {
              await guard[method]();
              expect(lookups).toHaveLength(1);
              expect(lookups[0][3]).toEqual({ throwOnLookupTimeout: true });
            }
          } finally {
            warn.mockRestore();
          }
        });
      }
    }
  }

  test("verifyInstalledAppBundle does nothing when the operator skipped hash verification", async () => {
    const lookups: unknown[][] = [];
    const guard = new DefaultIosAppBundleGuard({
      device: { deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", platform: "ios", name: "iPhone" },
      deviceAppManager: {
        getInstalledAppBundleHash: async (...args: unknown[]) => {
          lookups.push(args);
          return "installed-hash";
        },
        uninstallApp: async () => {},
      },
      processExecutor: new FakeProcessExecutor(),
      timer: new FakeTimer(),
      appBundleId: APP_BUNDLE_ID,
      legacyAppBundleId: LEGACY_APP_BUNDLE_ID,
      isSimulator: () => true,
      isHashVerificationSkipped: () => true,
      getExpectedAppHash: () => "expected-hash",
    });

    await guard.verifyInstalledAppBundle();

    expect(lookups).toEqual([]);
  });
});

afterEach(() => {
  mock.restore();
});
