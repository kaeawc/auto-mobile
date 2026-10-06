import { describe, expect, test } from "bun:test";
import { migratePlan, migratePlanStep } from "../../../src/utils/plan/PlanMigrator";
import { getMcpServerVersion, releaseVersion } from "../../../src/utils/mcpVersion";

describe("PlanMigrator", () => {
  describe("version metadata (dev-build SHA stamp)", () => {
    // Regression: dev builds report a git-SHA-stamped version (`0.0.39+g<sha>[.dirty]`).
    // The runtime target version is stamped, and PlanSerializer persists the same
    // stamped string into a plan's mcpVersion. parseVersion must strip the metadata
    // or the SHA's hex digits corrupt the patch number and `.dirty` → NaN → the plan
    // is falsely reported outdated.
    test("a plan at the current release is not falsely reported outdated under a dev-stamped runtime", () => {
      const currentRelease = releaseVersion(getMcpServerVersion());
      const { report } = migratePlan({
        mcpVersion: currentRelease,
        steps: [{ tool: "observe", params: {} }],
      });
      expect(report.outdated).toBe(false);
    });

    test("a plan written by a dev build (stamped mcpVersion) at the current release is not outdated", () => {
      const currentRelease = releaseVersion(getMcpServerVersion());
      const { report } = migratePlan({
        mcpVersion: `${currentRelease}+g1a2b3c4d5e6f.dirty`,
        steps: [{ tool: "observe", params: {} }],
      });
      expect(report.outdated).toBe(false);
    });

    test("a genuinely older release version is still reported outdated", () => {
      const { report } = migratePlan({
        mcpVersion: "0.0.1",
        steps: [{ tool: "observe", params: {} }],
      });
      expect(report.outdated).toBe(true);
    });
  });

  describe("migratePlan", () => {
    test("throws for non-object input", () => {
      expect(() => migratePlan("not an object")).toThrow("Plan is not a valid object");
      expect(() => migratePlan(null)).toThrow("Plan is not a valid object");
      expect(() => migratePlan(42)).toThrow("Plan is not a valid object");
      expect(() => migratePlan([])).toThrow("Plan is not a valid object");
    });

    test("passes through a current-version plan with minimal changes", () => {
      const input = {
        name: "Current Plan",
        mcpVersion: "99.99.99",
        metadata: {
          createdAt: "2024-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
        steps: [{ tool: "tapOn", params: { text: "Hello" } }],
      };

      const { plan } = migratePlan(input);

      expect(plan.name).toBe("Current Plan");
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].tool).toBe("tapOn");
    });

    describe("plan field migrations", () => {
      test("renames planName to name", () => {
        const { plan, report } = migratePlan({
          planName: "Old Name",
          steps: [{ tool: "observe", params: {} }],
        });

        expect(plan.name).toBe("Old Name");
        expect(plan.planName).toBeUndefined();
        expect(report.migrated).toBe(true);
        expect(report.appliedMigrations).toContain("plan-fields");
        expect(report.warnings.some((w) => w.message.includes("Renamed planName to name"))).toBe(
          true,
        );
      });

      test("moves metadata.name to plan name", () => {
        const { plan, report } = migratePlan({
          metadata: { name: "Meta Name" },
          steps: [{ tool: "observe", params: {} }],
        });

        expect(plan.name).toBe("Meta Name");
        expect(plan.metadata.name).toBeUndefined();
        expect(report.migrated).toBe(true);
      });

      test("moves metadata.description to plan description", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          metadata: { description: "Meta Description" },
          steps: [{ tool: "observe", params: {} }],
        });

        expect(plan.description).toBe("Meta Description");
        expect(plan.metadata.description).toBeUndefined();
        expect(report.migrated).toBe(true);
      });

      test("maps generated timestamp to metadata.createdAt", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          generated: "2024-06-15T12:00:00.000Z",
          steps: [{ tool: "observe", params: {} }],
        });

        expect(plan.metadata.createdAt).toBe("2024-06-15T12:00:00.000Z");
        expect(plan.generated).toBeUndefined();
        expect(report.migrated).toBe(true);
        expect(report.warnings.some((w) => w.message.includes("generated timestamp"))).toBe(true);
      });

      test("moves top-level appId to metadata.appId", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          appId: "com.example.app",
          steps: [{ tool: "observe", params: {} }],
        });

        expect(plan.metadata.appId).toBe("com.example.app");
        expect(plan.appId).toBeUndefined();
        expect(report.migrated).toBe(true);
      });

      test("moves metadata.mcpVersion to top-level mcpVersion", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          metadata: { mcpVersion: "1.2.3" },
          steps: [{ tool: "observe", params: {} }],
        });

        expect(plan.mcpVersion).toBe("1.2.3");
        expect(plan.metadata.mcpVersion).toBeUndefined();
        expect(report.migrated).toBe(true);
      });

      test("defaults missing mcpVersion to unknown", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          steps: [{ tool: "observe", params: {} }],
        });

        expect(plan.mcpVersion).toBe("unknown");
        expect(report.migrated).toBe(true);
        expect(
          report.warnings.some((w) => w.message.includes("Defaulted missing mcpVersion")),
        ).toBe(true);
      });

      test("defaults missing metadata.createdAt", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          steps: [{ tool: "observe", params: {} }],
        });

        // The default createdAt is stamped as an ISO-8601 UTC timestamp; assert
        // the exact shape rather than merely that some string is present.
        expect(plan.metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(report.migrated).toBe(true);
      });

      test("defaults missing metadata.version to 1.0.0", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          steps: [{ tool: "observe", params: {} }],
        });

        expect(plan.metadata.version).toBe("1.0.0");
        expect(report.migrated).toBe(true);
      });

      test("resets non-object metadata with warning", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          metadata: "not an object",
          steps: [{ tool: "observe", params: {} }],
        });

        expect(typeof plan.metadata).toBe("object");
        expect(report.warnings.some((w) => w.message.includes("metadata was not an object"))).toBe(
          true,
        );
      });
    });

    describe("step field migrations", () => {
      test("renames command to tool", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ command: "tapOn", params: { text: "Hello" } }],
        });

        expect(plan.steps[0].tool).toBe("tapOn");
        expect(plan.steps[0].command).toBeUndefined();
        expect(report.appliedMigrations).toContain("step-fields");
      });

      test("renames tapOnText to tapOn", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "tapOnText", params: { text: "Hello" } }],
        });

        expect(plan.steps[0].tool).toBe("tapOn");
        expect(report.warnings.some((w) => w.message.includes("Renamed tapOnText to tapOn"))).toBe(
          true,
        );
      });

      test("renames swipeOnScreen to swipeOn and defaults autoTarget", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "swipeOnScreen", params: { direction: "up" } }],
        });

        expect(plan.steps[0].tool).toBe("swipeOn");
        expect(plan.steps[0].params.autoTarget).toBe(false);
        expect(
          report.warnings.some((w) => w.message.includes("Renamed swipeOnScreen to swipeOn")),
        ).toBe(true);
      });

      test("renames scroll to swipeOn and defaults gestureType", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "scroll", params: { direction: "down" } }],
        });

        expect(plan.steps[0].tool).toBe("swipeOn");
        expect(plan.steps[0].params.gestureType).toBe("scrollTowardsDirection");
      });

      test("renames packageName to appId for launchApp", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "launchApp", params: { packageName: "com.example" } }],
        });

        expect(plan.steps[0].params.appId).toBe("com.example");
        expect(plan.steps[0].params.packageName).toBeUndefined();
      });

      test("renames bundleId to appId for terminateApp", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "terminateApp", params: { bundleId: "com.example.ios" } }],
        });

        expect(plan.steps[0].params.appId).toBe("com.example.ios");
        expect(plan.steps[0].params.bundleId).toBeUndefined();
      });

      test("renames packageName to appId for crashApp", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "crashApp", params: { packageName: "com.example.app" } }],
        });

        expect(plan.steps[0].params.appId).toBe("com.example.app");
        expect(plan.steps[0].params.packageName).toBeUndefined();
      });

      test("defaults tapOn.action to tap", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "tapOn", params: { text: "Hello" } }],
        });

        expect(plan.steps[0].params.action).toBe("tap");
      });

      test("renames id to elementId for tapOn (wrapped into selector)", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "tapOn", params: { id: "submit_button" } }],
        });

        const selector = plan.steps[0].params.selector as { elementId?: string };
        expect(selector.elementId).toBe("submit_button");
        expect(plan.steps[0].params.id).toBeUndefined();
        expect(plan.steps[0].params.elementId).toBeUndefined();
      });

      test("wraps legacy tapOn { text } under { selector: { text } } for 0.0.30+ schema", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "tapOn", params: { text: "Schedule Appointment" } }],
        });

        const selector = plan.steps[0].params.selector as { text?: string };
        expect(selector.text).toBe("Schedule Appointment");
        expect(plan.steps[0].params.text).toBeUndefined();
        expect(report.warnings.some((w) => w.message.includes("Wrapped legacy tapOn"))).toBe(true);
      });

      test("wraps legacy tapOn { textAny } under { selector: { textAny } }", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "tapOn", params: { textAny: ["Done", "Add"] } }],
        });

        const selector = plan.steps[0].params.selector as { textAny?: string[] };
        expect(selector.textAny).toEqual(["Done", "Add"]);
        expect(plan.steps[0].params.textAny).toBeUndefined();
        expect(report.warnings.some((w) => w.message.includes("Wrapped legacy tapOn"))).toBe(true);
      });

      test("does not double-wrap tapOn that already has selector", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [
            {
              tool: "tapOn",
              params: { selector: { text: "Already wrapped" } },
            },
          ],
        });

        const selector = plan.steps[0].params.selector as { text?: string };
        expect(selector.text).toBe("Already wrapped");
      });

      test("wraps both elementId and text together into selector", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [
            {
              tool: "tapOn",
              params: { elementId: "submit_btn", text: "Submit" },
            },
          ],
        });

        const selector = plan.steps[0].params.selector as { elementId?: string; text?: string };
        expect(selector.elementId).toBe("submit_btn");
        expect(selector.text).toBe("Submit");
        expect(plan.steps[0].params.elementId).toBeUndefined();
        expect(plan.steps[0].params.text).toBeUndefined();
      });

      test("migrates inputText value, mode, IME action, and dropped dismissal to sendKeys", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [
            {
              tool: "inputText",
              params: {
                value: "hello",
                selector: { elementId: "field" },
                mode: "eventAll",
                imeAction: "done",
                dismissKeyboard: true,
              },
            },
          ],
        });

        expect(plan.steps[0]).toEqual({
          tool: "sendKeys",
          params: {
            selector: { elementId: "field" },
            commands: [
              {
                action: "type",
                text: "hello",
                operation: "replace",
                mode: "eventAll",
              },
              { action: "key", key: "done" },
            ],
          },
        });
        expect(report.warnings.some((warning) => warning.message.includes("dismissKeyboard"))).toBe(
          true,
        );
      });

      test("migrates clearText to a sendKeys clear command", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "clearText", params: { platform: "android" } }],
        });

        expect(plan.steps[0]).toEqual({
          tool: "sendKeys",
          params: { platform: "android", commands: [{ action: "clear" }] },
        });
      });

      test("migrates iOS inputText to caret insertion without clearing existing text", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "inputText", params: { platform: "ios", text: "tail" } }],
        });

        expect(plan.steps[0].params.commands).toEqual([
          { action: "type", text: "tail", operation: "insert" },
        ]);
      });

      test("uses the top-level iOS platform hint for inputText without an inline platform", () => {
        const { plan } = migratePlan({
          name: "Plan",
          platform: "ios",
          steps: [{ tool: "inputText", params: { text: "tail" } }],
        });

        expect(plan.steps[0].params.commands).toEqual([
          { action: "type", text: "tail", operation: "insert" },
        ]);
      });

      test("uses a matching object device's iOS platform for inputText", () => {
        const { plan } = migratePlan({
          name: "Plan",
          devices: [{ label: "a", platform: "ios" }],
          steps: [{ tool: "inputText", params: { device: "a", text: "tail" } }],
        });

        expect(plan.steps[0].params.commands).toEqual([
          { action: "type", text: "tail", operation: "insert" },
        ]);
      });

      test("prefers a matching device platform over the top-level hint", () => {
        const { plan } = migratePlan({
          name: "Plan",
          platform: "android",
          devices: [{ label: "a", platform: "ios" }],
          steps: [{ tool: "inputText", params: { device: "a", text: "tail" } }],
        });

        expect(plan.steps[0].params.commands).toEqual([
          { action: "type", text: "tail", operation: "insert" },
        ]);
      });

      test("prefers inline platform over matching device and top-level hints", () => {
        const { plan } = migratePlan({
          name: "Plan",
          platform: "android",
          devices: [{ label: "a", platform: "android" }],
          steps: [{ tool: "inputText", params: { platform: "ios", device: "a", text: "tail" } }],
        });

        expect(plan.steps[0].params.commands).toEqual([
          { action: "type", text: "tail", operation: "insert" },
        ]);
      });

      test("uses replace for an Android plan-level platform hint", () => {
        const { plan } = migratePlan({
          name: "Plan",
          platform: "android",
          steps: [{ tool: "inputText", params: { text: "tail" } }],
        });

        expect(plan.steps[0].params.commands).toEqual([
          { action: "type", text: "tail", operation: "replace" },
        ]);
      });

      test("keeps replace when inputText has no platform signal", () => {
        const { plan } = migratePlan({
          name: "Plan",
          steps: [{ tool: "inputText", params: { text: "tail" } }],
        });

        expect(plan.steps[0].params.commands).toEqual([
          { action: "type", text: "tail", operation: "replace" },
        ]);
      });

      test("falls through a plain-string device label to the top-level platform hint", () => {
        const { plan } = migratePlan({
          name: "Plan",
          platform: "ios",
          devices: ["a"],
          steps: [{ tool: "inputText", params: { device: "a", text: "tail" } }],
        });

        expect(plan.steps[0].params.commands).toEqual([
          { action: "type", text: "tail", operation: "insert" },
        ]);
      });

      test("migrates imeAction to a sendKeys semantic key command", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "imeAction", params: { action: "search", platform: "ios" } }],
        });

        expect(plan.steps[0]).toEqual({
          tool: "sendKeys",
          params: {
            platform: "ios",
            commands: [{ action: "key", key: "search" }],
          },
        });
      });

      test("renames openLink.link to url", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "openLink", params: { link: "https://example.com" } }],
        });

        expect(plan.steps[0].params.url).toBe("https://example.com");
        expect(plan.steps[0].params.link).toBeUndefined();
      });

      test("migrates swipe containerElementId to container.elementId", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [
            {
              tool: "swipeOn",
              params: { direction: "up", containerElementId: "list_view" },
            },
          ],
        });

        expect(plan.steps[0].params.container).toEqual({ elementId: "list_view" });
        expect(plan.steps[0].params.containerElementId).toBeUndefined();
      });

      test("migrates swipe containerText to container.text", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [
            {
              tool: "swipeOn",
              params: { direction: "up", containerText: "My List" },
            },
          ],
        });

        expect(plan.steps[0].params.container).toEqual({ text: "My List" });
        expect(plan.steps[0].params.containerText).toBeUndefined();
      });

      test("maps swipe duration to speed and removes duration", () => {
        const { plan: planSlow } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "swipeOn", params: { direction: "up", duration: 1000 } }],
        });
        expect(planSlow.steps[0].params.speed).toBe("slow");
        expect(planSlow.steps[0].params.duration).toBeUndefined();

        const { plan: planFast } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "swipeOn", params: { direction: "up", duration: 200 } }],
        });
        expect(planFast.steps[0].params.speed).toBe("fast");

        const { plan: planNormal } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "swipeOn", params: { direction: "up", duration: 500 } }],
        });
        expect(planNormal.steps[0].params.speed).toBe("normal");
      });

      test("removes deprecated scrollMode from swipeOn", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "swipeOn", params: { direction: "up", scrollMode: "fast" } }],
        });

        expect(plan.steps[0].params.scrollMode).toBeUndefined();
        expect(
          report.warnings.some((w) => w.message.includes("Removed deprecated scrollMode")),
        ).toBe(true);
      });

      test("moves systemTray notification.timeout to awaitTimeout", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [
            {
              tool: "systemTray",
              action: "tap",
              notification: { title: "Test notification", timeout: 15000 },
            },
          ],
        });

        expect(plan.steps[0].params.awaitTimeout).toBe(15000);
        expect(plan.steps[0].params.notification.timeout).toBeUndefined();
        expect(plan.steps[0].params.notification.title).toBe("Test notification");
        expect(
          report.warnings.some((w) => w.message.includes("notification.timeout to awaitTimeout")),
        ).toBe(true);
      });

      test("does not overwrite explicit awaitTimeout with notification.timeout", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [
            {
              tool: "systemTray",
              action: "tap",
              notification: { title: "Test", timeout: 15000 },
              awaitTimeout: 10000,
            },
          ],
        });

        expect(plan.steps[0].params.awaitTimeout).toBe(10000);
      });

      test("removes deprecated observe.withViewHierarchy", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "observe", params: { withViewHierarchy: true } }],
        });

        expect(plan.steps[0].params.withViewHierarchy).toBeUndefined();
        expect(
          report.warnings.some((w) =>
            w.message.includes("Removed deprecated observe.withViewHierarchy"),
          ),
        ).toBe(true);
      });

      test("maps step description to label", () => {
        const { plan, report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "tapOn", description: "Click the button", params: { text: "Go" } }],
        });

        expect(plan.steps[0].label).toBe("Click the button");
        expect(plan.steps[0].description).toBeUndefined();
        expect(
          report.warnings.some((w) => w.message.includes("Mapped step description to label")),
        ).toBe(true);
      });

      test("merges inline step fields into params (tapOn text wrapped under selector)", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "tapOn", text: "Hello", action: "tap" }],
        });

        const selector = plan.steps[0].params.selector as { text?: string };
        expect(selector.text).toBe("Hello");
        expect(plan.steps[0].params.action).toBe("tap");
        expect(plan.steps[0].params.text).toBeUndefined();
      });

      test("skips non-record steps", () => {
        const { plan } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: ["not a step", 42, null],
        });

        expect(plan.steps).toHaveLength(3);
        // Non-record steps are passed through unchanged
        expect(plan.steps[0]).toBe("not a step");
      });
    });

    describe("migration report", () => {
      test("reports original and target versions", () => {
        const { report } = migratePlan({
          name: "Plan",
          mcpVersion: "0.5.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "observe", params: {} }],
        });

        expect(report.originalVersion).toBe("0.5.0");
        expect(typeof report.targetVersion).toBe("string");
      });

      test("detects unknown original version", () => {
        const { report } = migratePlan({
          name: "Plan",
          steps: [{ tool: "observe", params: {} }],
        });

        expect(report.originalVersion).toBe("unknown");
      });

      test("reads mcpVersion from metadata if not at top level", () => {
        const { report } = migratePlan({
          name: "Plan",
          metadata: { mcpVersion: "0.3.0" },
          steps: [{ tool: "observe", params: {} }],
        });

        expect(report.originalVersion).toBe("0.3.0");
      });

      test("reports outdated when version is older", () => {
        const { report } = migratePlan({
          name: "Plan",
          mcpVersion: "0.0.1",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [{ tool: "observe", params: {} }],
        });

        expect(report.outdated).toBe(true);
      });

      test("reports not migrated when no changes needed", () => {
        // Build a fully-specified plan that needs no migration
        const { report } = migratePlan({
          name: "Current",
          mcpVersion: "99.99.99",
          metadata: {
            createdAt: "2024-01-01T00:00:00.000Z",
            version: "1.0.0",
          },
          steps: [{ tool: "observe", params: {} }],
        });

        expect(report.migrated).toBe(false);
        expect(report.appliedMigrations).toHaveLength(0);
      });

      test("includes step index in step warnings", () => {
        const { report } = migratePlan({
          name: "Plan",
          mcpVersion: "1.0.0",
          metadata: { createdAt: "2024-01-01", version: "1.0.0" },
          steps: [
            { tool: "observe", params: {} },
            { command: "tapOn", params: { text: "Go" } },
          ],
        });

        const stepWarnings = report.warnings.filter((w) => w.stepIndex !== undefined);
        expect(stepWarnings.length).toBeGreaterThan(0);
        // The second step (index 1) should have had command -> tool migration
        expect(stepWarnings.some((w) => w.stepIndex === 1)).toBe(true);
      });
    });
  });
});

describe("PlanMigrator complete step migration results", () => {
  test.each([
    ["missing tool", { command: 2, description: "legacy", params: null }],
    [
      "command alias",
      {
        command: "tapOnText",
        description: "legacy",
        optional: true,
        text: "inline",
        params: { text: "override" },
      },
    ],
    [
      "existing fields",
      {
        tool: "observe",
        command: "ignored",
        label: "kept",
        description: "ignored",
        params: { withViewHierarchy: false },
      },
    ],
    ["non-string description", { tool: "observe", description: 4 }],
    ["swipe alias defaults", { tool: "swipeOnScreen" }],
    ["swipe alias explicit", { tool: "swipeOnScreen", params: { autoTarget: true } }],
    ["scroll defaults", { tool: "scroll" }],
    ["scroll explicit", { tool: "scroll", params: { gestureType: "custom" } }],
    [
      "input all fields",
      {
        tool: "inputText",
        params: {
          value: "hello",
          mode: "eventAll",
          imeAction: "done",
          dismissKeyboard: false,
          platform: "ios",
        },
      },
    ],
    ["input text wins", { tool: "inputText", params: { value: "old", text: "new" } }],
    ["input missing text", { tool: "inputText", params: {} }],
    ["clear", { tool: "clearText", params: { commands: ["old"] } }],
    ["IME", { tool: "imeAction", params: { action: "search" } }],
    ["package wins", { tool: "launchApp", params: { packageName: "package", bundleId: "bundle" } }],
    ["bundle fallback", { tool: "terminateApp", params: { packageName: 2, bundleId: "bundle" } }],
    [
      "existing app ID",
      { tool: "stopApp", params: { appId: "kept", packageName: "package", bundleId: "bundle" } },
    ],
    ["missing app ID", { tool: "crashApp", params: {} }],
    [
      "tap selector fields",
      { tool: "tapOn", params: { id: "button", text: "text", textAny: ["one", "two"] } },
    ],
    [
      "tap existing selector",
      {
        tool: "tapOn",
        params: { action: "longPress", id: "old", elementId: "kept", text: "text", selector: {} },
      },
    ],
    [
      "tap invalid selector",
      { tool: "tapOn", params: { selector: [], elementId: 4, text: 2, textAny: "bad" } },
    ],
    ["link rename", { tool: "openLink", params: { link: "https://example.com" } }],
    ["existing URL", { tool: "openLink", params: { url: "kept", link: "ignored" } }],
    ["non-string link", { tool: "openLink", params: { link: 4 } }],
    [
      "swipe container",
      {
        tool: "swipeOn",
        params: {
          containerElementId: "list",
          containerText: "text",
          duration: 800,
          scrollMode: "old",
        },
      },
    ],
    ["swipe fast", { tool: "swipeOn", params: { duration: 250 } }],
    ["swipe normal", { tool: "swipeOn", params: { duration: 500 } }],
    [
      "swipe existing fields",
      {
        tool: "swipeOn",
        params: {
          container: { elementId: "kept", text: "kept" },
          containerElementId: "ignored",
          containerText: "ignored",
          duration: 1000,
          speed: "custom",
        },
      },
    ],
    [
      "swipe invalid duration",
      {
        tool: "swipeOn",
        params: { container: [], containerElementId: 4, containerText: 2, duration: "slow" },
      },
    ],
    [
      "notification timeout",
      { tool: "systemTray", params: { notification: { title: "title", timeout: 25 } } },
    ],
    [
      "notification explicit",
      { tool: "systemTray", params: { notification: { timeout: 25 }, awaitTimeout: 10 } },
    ],
    ["notification invalid", { tool: "systemTray", params: { notification: { timeout: "bad" } } }],
    ["notification absent", { tool: "systemTray", params: {} }],
    ["observe absent", { tool: "observe", params: {} }],
    ["unrecognized tool", { tool: "custom", params: {} }],
  ])("preserves the full result for %s", (_name, step) => {
    const result = migratePlan({
      name: "Characterization",
      mcpVersion: "99.99.99",
      metadata: { createdAt: "2024-01-01T00:00:00.000Z", version: "1.0.0" },
      steps: [structuredClone(step)],
    });
    expect(result.report.targetVersion).toBe(getMcpServerVersion());
    expect({
      ...result,
      report: { ...result.report, targetVersion: "<current-mcp-version>" },
    }).toMatchSnapshot();
  });
});

describe("PlanMigrator field precedence", () => {
  test("preserves field migration and warning order on combined legacy input", () => {
    const metadata = { name: "metadata name", description: "description", mcpVersion: "0.0.1" };
    const input = {
      planName: "legacy name",
      generated: "captured time",
      appId: "app",
      metadata,
      steps: [],
    };
    const { plan, report } = migratePlan(input);
    expect(plan).toBe(input);
    expect(plan.metadata).toBe(metadata);
    expect(plan).toEqual({
      name: "legacy name",
      description: "description",
      mcpVersion: "0.0.1",
      metadata: {
        name: "metadata name",
        createdAt: "captured time",
        appId: "app",
        version: "1.0.0",
      },
      steps: [],
    });
    expect(report.warnings.map((warning) => warning.message)).toEqual([
      "Renamed planName to name.",
      "Moved metadata.description to plan description.",
      "Mapped generated timestamp to metadata.createdAt.",
      "Removed deprecated generated field.",
      "Moved top-level appId to metadata.appId.",
      "Removed deprecated top-level appId field.",
      "Moved metadata.mcpVersion to top-level mcpVersion.",
      "Defaulted missing metadata.version to 1.0.0.",
    ]);
    expect(report.appliedMigrations).toEqual(["plan-fields"]);
  });
  test("keeps existing fields while removing deprecated generated and appId values", () => {
    const input = {
      name: "current",
      planName: "ignored",
      description: "current description",
      mcpVersion: "99.99.99",
      generated: 123,
      appId: null,
      metadata: {
        name: "ignored",
        description: "ignored",
        mcpVersion: "0.0.1",
        createdAt: "existing",
        appId: "existing",
        version: "2",
      },
      steps: [],
    };
    const { plan, report } = migratePlan(input);
    expect(plan.metadata).toEqual({
      name: "ignored",
      description: "ignored",
      mcpVersion: "0.0.1",
      createdAt: "existing",
      appId: "existing",
      version: "2",
    });
    expect(plan.planName).toBe("ignored");
    expect(plan.generated).toBeUndefined();
    expect(plan.appId).toBeUndefined();
    expect(report.warnings).toEqual([
      { message: "Removed deprecated generated field." },
      { message: "Removed deprecated top-level appId field." },
    ]);
  });
  test("keeps explicit tool, label, params and optional while removing legacy fields", () => {
    const step = {
      tool: "observe",
      command: "tapOn",
      label: "explicit",
      description: "ignored",
      optional: true,
      timeout: 1,
      params: { timeout: 2 },
    };
    const { plan, report } = migratePlan({
      name: "current",
      mcpVersion: "99.99.99",
      metadata: { createdAt: "existing", version: "1" },
      steps: [step],
    });
    expect(plan.steps[0]).toBe(step);
    expect(step).toEqual({
      tool: "observe",
      label: "explicit",
      optional: true,
      params: { timeout: 2 },
    });
    expect(report.warnings).toEqual([
      { message: "Removed deprecated command field.", stepIndex: 0 },
      { message: "Removed deprecated step description field.", stepIndex: 0 },
    ]);
    expect(report.appliedMigrations).toEqual(["step-fields"]);
  });
  test("migrates step metadata before returning for a non-string tool", () => {
    const step = { tool: 42, command: "ignored", description: "label", inline: "untouched" };
    const { report } = migratePlan({
      name: "current",
      mcpVersion: "99.99.99",
      metadata: { createdAt: "existing", version: "1" },
      steps: [step],
    });
    expect(step).toEqual({ tool: 42, label: "label", inline: "untouched" });
    expect(report.warnings).toEqual([
      { message: "Removed deprecated command field.", stepIndex: 0 },
      { message: "Mapped step description to label.", stepIndex: 0 },
      { message: "Removed deprecated step description field.", stepIndex: 0 },
    ]);
  });

  describe("migratePlanStep (criticalSection sub-steps, #9927)", () => {
    test("wraps a legacy tapOn { text } under selector without mutating the input", () => {
      const input = { tool: "tapOn", params: { device: "A", text: "Sync" } };
      expect(migratePlanStep(input, 0)).toEqual({
        tool: "tapOn",
        params: { device: "A", action: "tap", selector: { text: "Sync" } },
      });
      expect(input).toEqual({ tool: "tapOn", params: { device: "A", text: "Sync" } });
    });

    test("is idempotent on an already-migrated step", () => {
      const migrated = migratePlanStep({ tool: "tapOn", params: { device: "A", text: "Sync" } }, 0);
      expect(migratePlanStep(migrated, 0)).toEqual(migrated);
    });

    test("resolves the inputText operation from the supplied platform", () => {
      const step = { tool: "inputText", params: { device: "A", text: "hi" } };
      expect(migratePlanStep(step, 0, { platform: "ios" })).toMatchObject({
        tool: "sendKeys",
        params: { commands: [{ action: "type", text: "hi", operation: "insert" }] },
      });
    });

    test("returns a non-object step unchanged", () => {
      expect(migratePlanStep("nope", 0)).toBe("nope");
    });
  });
});
