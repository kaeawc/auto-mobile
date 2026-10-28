import { describe, expect, test } from "bun:test";
import { parseCli } from "../../../scripts/persona-robustness/run";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

const PLAN = `name: navigate-demo-index
steps:
  - tool: launchApp
    appId: dev.jasonpearson.automobile.playground
  - tool: observe
`;

const NOW = new Date("2026-10-28T12:34:56.789Z");
const read = () => PLAN;

describe("parseCli", () => {
  test("derives the app id from the plan's launchApp step", () => {
    const options = parseCli(["--plan", "p.yaml"], read, NOW);
    expect(options.harness.appId).toBe("dev.jasonpearson.automobile.playground");
    expect(options.harness.planName).toBe("navigate-demo-index");
    expect(options.harness.baseline.id).toBe("pixel-baseline");
    expect(options.harness.perturbations.length).toBeGreaterThan(3);
    expect(options.harness.repeats).toBe(1);
    expect(options.harness.ablate).toBe(false);
    expect(options.outDir).toEndWith("scratch/persona-robustness/2026-10-28T12-34-56Z");
  });

  test("passes the selection, repeats, ablation, session and avd through", () => {
    const options = parseCli(
      [
        "--plan",
        "p.yaml",
        "--app-id",
        "com.other",
        "--personas",
        "samsung-oneui, display:force-dark",
        "--repeats",
        "3",
        "--ablate",
        "--avd",
        "Pixel_9",
        "--out",
        "/tmp/out",
      ],
      read,
      NOW,
    );
    expect(options.harness.appId).toBe("com.other");
    expect(options.harness.perturbations.map((p) => p.id)).toEqual([
      "samsung-oneui",
      "display:force-dark",
    ]);
    expect(options.harness.repeats).toBe(3);
    expect(options.harness.ablate).toBe(true);
    expect(options.harness.acquireArgs).toEqual({ avdName: "Pixel_9" });
    expect(options.outDir).toBe("/tmp/out");
  });

  test("rejects a missing plan, a missing app id and a bad repeat count", () => {
    expect(() => parseCli([], read, NOW)).toThrow(/--plan/);
    expect(() =>
      parseCli(["--plan", "p.yaml"], () => "name: x\nsteps:\n  - tool: observe\n", NOW),
    ).toThrow(/--app-id/);
    expect(() => parseCli(["--plan", "p.yaml", "--repeats", "0"], read, NOW)).toThrow(/--repeats/);
  });
});
