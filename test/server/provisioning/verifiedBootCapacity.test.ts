import { expect, test } from "bun:test";
import { withVerifiedBootCapacity } from "../../../src/devices/bootAdmission/VerifiedBootCapacity";
import type { ExactDeviceProvisionRequest } from "../../../src/devices/exactDeviceProvisioning";
import { provisionExactDevice } from "../../../src/server/provisioning/provisioningBoot";
import { createPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import type { ProvisionDeviceArgs } from "../../../src/features/deviceLifecycle/deviceLifecycleCore";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE: Pick<ExactDeviceProvisionRequest, "platform" | "name" | "spec"> = {
  platform: "ios",
  name: "amslot-fresh-0-g1-unique",
  spec: { runtime: "iOS-18", deviceType: "iPhone-16" },
};

function harness() {
  const timer = new FakeTimer();
  timer.setCurrentTime(10_000);
  let capacityChecks = 0;
  let creates = 0;
  const requests: ExactDeviceProvisionRequest[] = [];
  const provision = async (
    device = DEVICE,
    beforeAssert = () => {},
    signal?: AbortSignal,
    options: Pick<ProvisionDeviceArgs, "boot" | "resources"> = { boot: true },
  ) =>
    await provisionExactDevice(
      { device, readiness: "none", ...options },
      {
        provision: async (request) => {
          requests.push(request);
          beforeAssert();
          await request.assertCapacityBeforeCreate?.(request.signal);
          request.onBeforeCreate?.();
          creates++;
          return {
            device: { ...device, isRunning: false },
            created: true,
            resolvedSpec: { ...device.spec, displayCutout: "none" },
          };
        },
      },
      createPerformanceTracker(false, timer),
      {
        timer,
        totalDeadlineMs: timer.now() + 60_000,
        markDeviceCreationStarted: () => {},
        lifecycleLease: {
          signal: new AbortController().signal,
          identity: { kind: "selector", platform: device.platform, selector: device.name },
          bindCanonicalIdentity: async () => {},
          transitionToTeardown: () => {},
          release: () => {},
        },
        collectPendingSettlement: () => {},
        signal,
        checkBootCapacity: async () => {
          capacityChecks++;
        },
      },
    );
  return { timer, provision, requests, counts: () => ({ capacityChecks, creates }) };
}

test("without a verified verdict the provisioner still checks before creating", async () => {
  const h = harness();
  await h.provision();
  expect(h.counts()).toEqual({ capacityChecks: 1, creates: 1 });
});

test("a fresh verdict does not bypass cancellation at the pre-create assertion", async () => {
  const h = harness();
  const controller = new AbortController();
  await expect(
    withVerifiedBootCapacity(DEVICE, h.timer.now(), h.timer, () =>
      h.provision(
        DEVICE,
        () => controller.abort(new Error("cancelled before create")),
        controller.signal,
      ),
    ),
  ).rejects.toThrow("cancelled before create");
  expect(h.counts()).toEqual({ capacityChecks: 0, creates: 0 });
});

test.each([0, 5_000, 5_001, -1])(
  "verdict age %i ms is checked at the pre-create assertion",
  async (ageMs) => {
    const h = harness();
    await withVerifiedBootCapacity(DEVICE, h.timer.now(), h.timer, () =>
      h.provision(DEVICE, () => h.timer.advanceTime(ageMs)),
    );
    expect(h.counts()).toEqual({
      capacityChecks: ageMs >= 0 && ageMs <= 5_000 ? 0 : 1,
      creates: 1,
    });
  },
);

test.each([
  { ...DEVICE, name: "another-create" },
  { ...DEVICE, platform: "android" },
  { ...DEVICE, spec: { ...DEVICE.spec, runtime: "iOS-17" } },
  { ...DEVICE, spec: { ...DEVICE.spec, deviceType: "iPhone-15" } },
] satisfies Array<typeof DEVICE>)(
  "a verdict for another request does not skip its check: %j",
  async (device) => {
    const h = harness();
    await withVerifiedBootCapacity(DEVICE, h.timer.now(), h.timer, () => h.provision(device));
    expect(h.counts()).toEqual({ capacityChecks: 1, creates: 1 });
  },
);

test("a verdict is consumed once and does not survive its request scope", async () => {
  const h = harness();
  await withVerifiedBootCapacity(DEVICE, h.timer.now(), h.timer, async () => {
    await h.provision();
    await h.provision();
  });
  await h.provision();
  expect(h.counts()).toEqual({ capacityChecks: 2, creates: 3 });
});

test("an unrelated concurrent request cannot consume the available verdict", async () => {
  const h = harness();
  await Promise.all([
    withVerifiedBootCapacity(DEVICE, h.timer.now(), h.timer, () => h.provision()),
    h.provision(),
  ]);
  expect(h.counts()).toEqual({ capacityChecks: 1, creates: 2 });
});

test("a nested request without verification cannot inherit its caller's verdict", async () => {
  const h = harness();
  await withVerifiedBootCapacity(DEVICE, h.timer.now(), h.timer, async () => {
    await withVerifiedBootCapacity(DEVICE, undefined, h.timer, () => h.provision());
    await h.provision();
  });
  expect(h.counts()).toEqual({ capacityChecks: 1, creates: 2 });
});

test("a late async descendant cannot use a verdict after its request returns", async () => {
  const h = harness();
  const released = Promise.withResolvers<void>();
  let descendant: Promise<unknown> | undefined;
  await withVerifiedBootCapacity(DEVICE, h.timer.now(), h.timer, async () => {
    descendant = released.promise.then(() => h.provision());
  });
  released.resolve();
  await descendant;
  expect(h.counts()).toEqual({ capacityChecks: 1, creates: 1 });
});

test("forwards resources only when provisioning for boot with resources", async () => {
  const h = harness();
  const resources = { widgets: "disabled" } as const;
  await h.provision(DEVICE, undefined, undefined, { boot: true, resources });
  await h.provision(DEVICE, undefined, undefined, { boot: false, resources });
  await h.provision(DEVICE, undefined, undefined, { boot: true });
  expect(h.requests[0]?.resources).toEqual(resources);
  expect(h.requests[1]).not.toHaveProperty("resources");
  expect(h.requests[2]).not.toHaveProperty("resources");
});
