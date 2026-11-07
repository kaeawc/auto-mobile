import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { registerInteractionTools } from "../../../src/server/interactionTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/systemTrayHelpers";
import { parseSimctlListApps } from "../../../src/utils/ios-cmdline-tools/simctlListApps";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { observeResultFromJsonText } from "../../helpers/observeFixture";
import { toolJson } from "../../helpers/toolResponse";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

// iOS 26.5 notification center whose only row reads "MESSAGES, Grouped, now, mt0091c,
// hello tray" (#17388), and the matching `simctl listapps` payload for that simulator.
const fixtureDir = join(import.meta.dir, "../../fixtures/systemTray/ios-26.5");
const readFixture = (name: string) => readFileSync(join(fixtureDir, name), "utf8");
const messagesTray: ObserveResult = observeResultFromJsonText(
  (
    JSON.parse(readFixture("full-tray-open-messages-grouped.json")) as {
      content: [{ text: string }];
    }
  ).content[0].text,
  "full-tray-open-messages-grouped.json",
);
const listedApps = parseSimctlListApps(readFixture("simctl-listapps-messages.json"));

const iosDevice: BootedDevice = {
  name: "iPhone 17 Pro",
  platform: "ios",
  deviceId: "45D48E06-E6AC-4894-B738-4EA7B6835D46",
  source: "local",
};

const install = (apps = listedApps, observation = messagesTray) => {
  const labelLookups: string[] = [];
  const observer = new FakeObserveScreen();
  observer.setObserveResult(() => observation);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  setSystemTrayDependencies({
    timer,
    observeScreenFactory: () => observer,
    appInventoryFactory: () => ({
      executeDetailedResult: async () => {
        throw new Error("Android inventory must not be read on iOS");
      },
      executeIosDetailedResult: async () => ({ apps, successful: true }),
    }),
    // The production resolver answers null on iOS; record any fallback call.
    appLabelResolver: async (_device, appId) => {
      labelLookups.push(appId);
      return null;
    },
  });
  registerInteractionTools();
  return { labelLookups };
};

const find = (notification: Record<string, string>) =>
  ToolRegistry.getTool("systemTray")!.deviceAwareHandler!(iosDevice, {
    action: "find",
    platform: "ios",
    awaitTimeout: 500,
    notification,
  });

afterEach(() => {
  resetSystemTrayDependencies();
  ToolRegistry.clearTools();
});

describe("systemTray find with appId on iOS", () => {
  test("matches the row by the installed app's display name", async () => {
    const { labelLookups } = install();
    const payload = toolJson(await find({ title: "mt0091c", appId: "com.apple.MobileSMS" }));
    expect(payload).toMatchObject({ success: true, match: { app: { text: "Messages" } } });
    expect(labelLookups).toEqual([]);
  });

  test("matches an appId-only query by display name", async () => {
    install();
    const payload = toolJson(await find({ appId: "com.apple.MobileSMS" }));
    expect(payload.success).toBe(true);
  });

  test("does not match a row whose app display name differs", async () => {
    install();
    await expect(find({ title: "mt0091c", appId: "com.apple.Preferences" })).rejects.toThrow(
      "Notification not found",
    );
  });

  test("keeps a direct bundle-id match when the listing has no display name", async () => {
    // Derived from the capture: a row that carries the bundle id instead of the name.
    const bundleIdTray = JSON.parse(
      JSON.stringify(messagesTray).replaceAll("MESSAGES, Grouped", "com.apple.MobileSMS, Grouped"),
    ) as ObserveResult;
    const { labelLookups } = install([{ bundleId: "com.apple.MobileSMS" }], bundleIdTray);
    const payload = toolJson(await find({ title: "mt0091c", appId: "com.apple.MobileSMS" }));
    expect(payload).toMatchObject({
      success: true,
      match: { app: { text: "com.apple.MobileSMS" } },
    });
    expect(labelLookups).toEqual(["com.apple.MobileSMS"]);
  });
});
