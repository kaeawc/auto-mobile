import { beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ViewHierarchyNode, ViewHierarchyResult } from "../../../../src/models";
import {
  createObserveHierarchyReader,
  createTapOnTapper,
  SYSTEM_ALERT_MAX_ANSWERS_PER_ACTION,
  SystemAlertGate,
  type SystemAlertTapSelector,
} from "../../../../src/features/action/systemAlerts/SystemAlertGate";
import type { ObserveResult } from "../../../../src/models";
import {
  reportToolDispatched,
  runWithToolDispatchReporter,
} from "../../../../src/utils/ToolDispatchContext";
import { SystemAlertPolicyRegistry } from "../../../../src/features/action/systemAlerts/SystemAlertPolicy";

const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "SIM-1" };
const bounds = { left: 0, top: 0, right: 100, bottom: 50 };
const node = (attrs: Record<string, unknown>, children?: ViewHierarchyNode[]): ViewHierarchyNode =>
  ({ $: { bounds, ...attrs }, ...(children ? { node: children } : {}) }) as ViewHierarchyNode;
const tree = (root: ViewHierarchyNode): ViewHierarchyResult => ({ hierarchy: { node: root } });
const pc = (id: string) => `com.android.permissioncontroller:id/${id}`;

const permission = (subject: string) =>
  tree(
    node({}, [
      node({ "resource-id": pc("permission_message"), text: `Allow Demo to ${subject}?` }),
      node({
        "resource-id": pc("permission_allow_foreground_only_button"),
        text: "While using the app",
      }),
      node({ "resource-id": pc("permission_deny_button"), text: "Don't allow" }),
    ]),
  );
const noAlert = tree(node({ text: "Home" }));
const iosLocation = tree(
  node({ className: "UIApplication" }, [
    node({ className: "UIAlertController", text: "Allow “Demo” to use your location?" }, [
      node({ className: "UIButton", role: "button", text: "Allow Once" }),
      node({ className: "UIButton", role: "button", text: "Allow While Using App" }),
      node({ className: "UIButton", role: "button", text: "Don’t Allow" }),
    ]),
  ]),
);

describe("SystemAlertGate (#14106)", () => {
  let registry: SystemAlertPolicyRegistry;
  let screens: Array<ViewHierarchyResult | Error>;
  let reads: number;
  let taps: SystemAlertTapSelector[];
  let tapResult: { success: boolean; error?: string };
  let gate: SystemAlertGate;

  beforeEach(() => {
    registry = new SystemAlertPolicyRegistry();
    screens = [];
    reads = 0;
    taps = [];
    tapResult = { success: true };
    gate = new SystemAlertGate({
      registry,
      reader: {
        read: async () => {
          reads += 1;
          const next = screens.length > 1 ? screens.shift()! : (screens[0] ?? noAlert);
          if (next instanceof Error) {
            throw next;
          }
          return next;
        },
      },
      tapper: {
        tap: async (_device, selector) => {
          taps.push(selector);
          return tapResult;
        },
      },
    });
  });

  test("does nothing, not even a read, when the device has no policy", async () => {
    screens = [permission("access this device's location")];
    expect(await gate.beforeAction(android)).toEqual([]);
    expect(reads).toBe(0);
  });

  test("report never taps but surfaces the alert", async () => {
    registry.set(android.deviceId, { policy: "report", match: [] });
    screens = [permission("access this device's location")];
    const warnings = await gate.beforeAction(android);
    expect(taps).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Allow Demo to access this device's location?");
    expect(warnings[0]).toContain("report");
  });

  test("allow answers an Android permission dialog and reports what it tapped", async () => {
    registry.set(android.deviceId, { policy: "allow", match: [] });
    screens = [permission("access this device's location"), noAlert];
    const warnings = await gate.beforeAction(android);
    expect(taps).toEqual([{ elementId: pc("permission_allow_foreground_only_button") }]);
    expect(warnings).toEqual([
      `Answered system alert "Allow Demo to access this device's location?" with "While using the app" (systemAlerts policy allow).`,
    ]);
  });

  test("allow answers an iOS location alert by its label", async () => {
    registry.set(ios.deviceId, { policy: "allow", match: [] });
    screens = [iosLocation, noAlert];
    await gate.beforeAction(ios);
    expect(taps).toEqual([{ text: "Allow While Using App" }]);
  });

  test("answers back-to-back prompts, up to a bound", async () => {
    registry.set(android.deviceId, { policy: "deny", match: [] });
    screens = [permission("access this device's location"), permission("take pictures"), noAlert];
    const warnings = await gate.beforeAction(android);
    expect(taps).toHaveLength(2);
    expect(warnings).toHaveLength(2);

    taps = [];
    screens = Array.from({ length: SYSTEM_ALERT_MAX_ANSWERS_PER_ACTION + 2 }, (_, index) =>
      permission(`use thing ${index}`),
    );
    const capped = await gate.beforeAction(android);
    expect(taps).toHaveLength(SYSTEM_ALERT_MAX_ANSWERS_PER_ACTION);
    expect(capped.at(-1)).toContain(
      `after ${SYSTEM_ALERT_MAX_ANSWERS_PER_ACTION} alerts were answered`,
    );
  });

  test("stops when a tap leaves the same alert showing", async () => {
    registry.set(android.deviceId, { policy: "allow", match: [] });
    screens = [permission("access this device's location")];
    const warnings = await gate.beforeAction(android);
    expect(taps).toHaveLength(1);
    expect(warnings.at(-1)).toContain("still showing");
  });

  test("an alert the policy cannot answer is reported as unmatched, never tapped", async () => {
    registry.set(ios.deviceId, { policy: "allow", match: [] });
    screens = [
      tree(
        node({ className: "UIAlertController", text: "„Demo“ möchte auf deine Kamera zugreifen" }, [
          node({ className: "UIButton", role: "button", text: "Nicht erlauben" }),
          node({ className: "UIButton", role: "button", text: "Erlauben" }),
        ]),
      ),
    ];
    const warnings = await gate.beforeAction(ios);
    expect(taps).toEqual([]);
    expect(warnings[0]).toContain("unmatched");
    expect(warnings[0]).toContain("Nicht erlauben");
    expect(warnings[0]).toStartWith("Alert ");
  });

  test("a failed tap or read is a warning, never a thrown error", async () => {
    registry.set(android.deviceId, { policy: "allow", match: [] });
    screens = [permission("access this device's location")];
    tapResult = { success: false, error: "no element" };
    expect((await gate.beforeAction(android))[0]).toContain("Failed to answer");

    screens = [new Error("hierarchy unavailable")];
    expect((await gate.beforeAction(android))[0]).toContain("Could not check for a system alert");
  });

  test("a cancelled action stops the check", async () => {
    registry.set(android.deviceId, { policy: "allow", match: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(gate.beforeAction(android, controller.signal)).rejects.toThrow();
    expect(reads).toBe(0);
  });

  test("after an action, a prompt that action raised is answered too", async () => {
    registry.set(android.deviceId, { policy: "allow", match: [] });
    screens = [permission("take pictures"), noAlert];
    const warnings = await gate.afterAction(android);
    expect(taps).toHaveLength(1);
    expect(warnings[0]).toStartWith("Answered system alert");
  });

  test("a policy cleared mid-check stops the next tap", async () => {
    registry.set(android.deviceId, { policy: "allow", match: [] });
    const queue = [permission("access this device's location"), permission("take pictures")];
    gate = new SystemAlertGate({
      registry,
      reader: { read: async () => queue.shift() ?? noAlert },
      tapper: {
        tap: async (_device, selector) => {
          taps.push(selector);
          registry.clear(android.deviceId);
          return { success: true };
        },
      },
    });
    await gate.beforeAction(android);
    expect(taps).toHaveLength(1);
  });
});

describe("SystemAlertGate defaults (#14106)", () => {
  test("a capture that yields no hierarchy is a failed read, reported as a warning", async () => {
    const registry = new SystemAlertPolicyRegistry();
    registry.set(android.deviceId, { policy: "allow", match: [] });
    const fallback: Pick<ObserveResult, "error"> = { error: "device offline" };
    const gate = new SystemAlertGate({
      registry,
      reader: createObserveHierarchyReader(() => ({
        execute: async () => fallback,
      })),
      tapper: { tap: async () => ({ success: true }) },
    });
    expect(await gate.beforeAction(android)).toEqual([
      "Could not check for a system alert before this action: device offline",
    ]);
  });

  test("the alert tap is not reported as the running tool's dispatch", async () => {
    let dispatched = 0;
    const tapper = createTapOnTapper(() => ({
      execute: async () => {
        reportToolDispatched();
        return { success: true };
      },
    }));
    await runWithToolDispatchReporter(
      () => {
        dispatched += 1;
      },
      () => tapper.tap(android, { text: "Allow" }),
    );
    expect(dispatched).toBe(0);
  });
});
