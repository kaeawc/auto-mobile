import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import {
  runWithToolDispatchReporter,
  reportToolDispatched,
} from "../../../src/utils/ToolDispatchContext";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP = "com.example.dispatch";
const T0 = 2_000_000;

/**
 * The 2 s tool-call window and the 10 s TTL are measured from when the call's gesture was
 * dispatched (#10196), not from when the tool started: a tapOn that waits for its target spends
 * seconds before it acts.
 */
describe("NavigationGraphManager tool-call dispatch window (#10196)", () => {
  let harness: InMemoryNavManagerHarness;
  let repository: NavigationRepository;
  let manager: NavigationGraphManager;
  let timer: FakeTimer;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  beforeEach(async () => {
    repository = new NavigationRepository(harness.db);
    await repository.clearAppGraph(APP);
    timer = new FakeTimer();
    timer.setCurrentTime(T0 - 100_000);
    manager = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      timer,
    );
    await navigate("Login", T0 - 100_000);
    timer.setCurrentTime(T0);
  });
  afterAll(async () => {
    await harness.dispose();
  });

  async function navigate(destination: string, at: number): Promise<void> {
    timer.setCurrentTime(at);
    await manager.recordNavigationEvent({
      applicationId: APP,
      destination,
      source: "sdk",
      arguments: {},
      metadata: {},
      timestamp: at,
      sequenceNumber: 0,
    });
  }

  async function tools(): Promise<Array<string | null>> {
    return (await repository.getEdges(APP)).map((edge) => edge.tool_name);
  }

  function startTap(): ReturnType<NavigationGraphManager["recordToolCall"]> {
    timer.setCurrentTime(T0);
    return manager.recordToolCall("tapOn", { selector: { text: "Continue" } });
  }

  test("a tap that waited 3 s for its target is attributed to it once dispatched", async () => {
    const call = startTap();
    timer.setCurrentTime(T0 + 3000);
    call.markDispatched?.();

    await navigate("Home", T0 + 3300);

    expect(await tools()).toEqual(["tapOn"]);
  });

  test("a call that never reports a dispatch is still measured from its start", async () => {
    startTap();

    await navigate("Home", T0 + 3300);

    expect(await tools()).toEqual([null]);
  });

  test("the window runs 2 s from the dispatch: 4.5 s labels, 5.5 s does not", async () => {
    const call = startTap();
    timer.setCurrentTime(T0 + 3000);
    call.markDispatched?.();

    await navigate("Home", T0 + 4500);
    expect(await tools()).toEqual(["tapOn"]);

    const late = startTap();
    timer.setCurrentTime(T0 + 3000);
    late.markDispatched?.();
    await navigate("Settings", T0 + 5500);

    expect(await tools()).toEqual(["tapOn", null]);
  });

  test("a call that waited longer than the history TTL is still attributed once dispatched", async () => {
    const call = startTap();
    // An unrelated event after 11 s prunes the in-flight call from the history.
    await navigate("Interstitial", T0 + 11_000);
    expect(await tools()).toEqual([null]);

    timer.setCurrentTime(T0 + 11_500);
    call.markDispatched?.();
    await navigate("Home", T0 + 11_800);

    expect(await tools()).toEqual([null, "tapOn"]);
  });

  test("a withdrawn call never labels anything, even if its dispatch is reported late", async () => {
    const call = startTap();
    call();
    timer.setCurrentTime(T0 + 100);
    call.markDispatched?.();

    await navigate("Home", T0 + 300);

    expect(await tools()).toEqual([null]);
    expect((await manager.getStats()).toolCallHistorySize).toBe(0);
  });

  test("a call consumed by an edge is not brought back by a later dispatch report", async () => {
    const call = startTap();
    await navigate("Home", T0 + 500);
    timer.setCurrentTime(T0 + 600);
    call.markDispatched?.();

    await navigate("Settings", T0 + 700);

    expect(await tools()).toEqual(["tapOn", null]);
  });

  test("the call that acted most recently wins over one that merely started later", async () => {
    const slow = startTap();
    timer.setCurrentTime(T0 + 200);
    manager.recordToolCall("pressButton", { button: "home" });
    timer.setCurrentTime(T0 + 900);
    slow.markDispatched?.();

    await navigate("Home", T0 + 1000);

    expect(await tools()).toEqual(["tapOn"]);
  });

  test("an unrelated earlier call stays uncorrelated", async () => {
    startTap();

    await navigate("Home", T0 + 2500);

    expect(await tools()).toEqual([null]);
  });

  describe("ambient dispatch reporting", () => {
    test("reports reach the reporter of the enclosing scope only", async () => {
      const reports: string[] = [];
      await runWithToolDispatchReporter(
        () => reports.push("outer"),
        async () => {
          await Promise.resolve();
          reportToolDispatched();
          await runWithToolDispatchReporter(
            () => reports.push("inner"),
            async () => reportToolDispatched(),
          );
        },
      );
      reportToolDispatched();

      expect(reports).toEqual(["outer", "inner"]);
    });

    test("a scope without a reporter leaves the enclosing one in place", () => {
      const reports: string[] = [];
      runWithToolDispatchReporter(
        () => reports.push("outer"),
        () => runWithToolDispatchReporter(undefined, () => reportToolDispatched()),
      );

      expect(reports).toEqual(["outer"]);
    });
  });
});
