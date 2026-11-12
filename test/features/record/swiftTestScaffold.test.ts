import { describe, expect, test } from "bun:test";
import {
  buildXCTestScaffold,
  planResourceFileName,
  xcTestClassName,
  xcTestScaffoldField,
} from "../../../src/features/record/swiftTestScaffold";

describe("XCTest scaffold for an exported plan", () => {
  test("generates the minimal AutoMobileTestCase subclass for the plan resource", () => {
    const scaffold = buildXCTestScaffold("launch-reminders-app");
    expect(scaffold.className).toBe("LaunchRemindersAppTests");
    expect(scaffold.swiftFileName).toBe("LaunchRemindersAppTests.swift");
    expect(scaffold.planFileName).toBe("launch-reminders-app.yaml");
    expect(scaffold.planResourcePath).toBe("test-plans/launch-reminders-app.yaml");
    expect(scaffold.swiftSource).toBe(`import XCTest
import XCTestRunner

final class LaunchRemindersAppTests: AutoMobileTestCase {
    override var planPath: String {
        "test-plans/launch-reminders-app.yaml"
    }

    func testLaunchRemindersApp() async throws {
        let result = try await executePlan()
        XCTAssertTrue(result.success, result.error ?? "AutoMobile plan failed")
    }
}
`);
  });

  test("derives a valid Swift identifier and a safe file name from any plan name", () => {
    expect(xcTestClassName("Checkout flow (v2)")).toBe("CheckoutFlowV2Tests");
    expect(xcTestClassName("mcp-recorded-plan-2026-11-11T14-53-07-554Z")).toBe(
      "McpRecordedPlan20261111T145307554ZTests",
    );
    expect(xcTestClassName("2fa login")).toBe("Plan2faLoginTests");
    expect(xcTestClassName("LoginTests")).toBe("LoginTests");
    expect(xcTestClassName("日本語")).toBe("RecordedPlanTests");
    expect(planResourceFileName('a"b\\c/../d')).toBe("a-b-c-d.yaml");
    expect(planResourceFileName("日本語")).toBe("recorded-plan.yaml");
  });

  test("the default yaml format adds no scaffold", () => {
    expect(xcTestScaffoldField(undefined, "p")).toEqual({});
    expect(xcTestScaffoldField("yaml", "p")).toEqual({});
    expect(xcTestScaffoldField("xctest", "p").xctest?.className).toBe("PTests");
  });
});
