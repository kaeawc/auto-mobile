import { describe, expect, test } from "bun:test";
import { latestSessionExecutionDeadlineMs } from "../../src/daemon/toolCallActivity";

// The idle-release veto asks this on every lookup of a session past its idle deadline. A derived
// `${base}:${label}` session counts its base session's executions too (#10712).

const BASE = "base-session";
const DERIVED = `${BASE}:tablet`;

function lookup(
  deadlines: Record<string, number | undefined>,
  options: { recovering?: string[]; labels?: Record<string, Record<string, string>> } = {},
) {
  const asked: Array<{ id: string; options: unknown }> = [];
  const tracker = {
    getLatestSessionExecutionDeadlineMs: (id: string, queryOptions?: unknown) => {
      asked.push({ id, options: queryOptions });
      return deadlines[id];
    },
  };
  const sessionManager = {
    getDeviceLabels: (sessionUuid: string) => options.labels?.[sessionUuid],
  };
  const devicePool = {
    isSessionRecoveryInFlight: (sessionId: string) =>
      options.recovering?.includes(sessionId) ?? false,
  };
  return {
    asked,
    latest: (
      sessionId: string,
      queryOptions?: { onSessionClock?: boolean; excludeReads?: boolean },
    ) =>
      latestSessionExecutionDeadlineMs(
        tracker,
        sessionManager,
        devicePool,
        sessionId,
        queryOptions,
      ),
  };
}

describe("latestSessionExecutionDeadlineMs", () => {
  test("a plain session reports its own executions' deadline, asking the tracker once", () => {
    const { asked, latest } = lookup({ [BASE]: 5_000 });

    expect(latest(BASE, { excludeReads: true })).toBe(5_000);
    expect(asked).toEqual([{ id: BASE, options: { excludeReads: true } }]);
  });

  test("nothing in flight is undefined", () => {
    expect(lookup({}).latest(BASE)).toBeUndefined();
  });

  test.each([
    ["only the derived session", { [DERIVED]: 4_000 }, 4_000],
    ["only its base session", { [BASE]: 7_000 }, 7_000],
    ["both: the later one", { [DERIVED]: 4_000, [BASE]: 7_000 }, 7_000],
    ["both, one unbounded", { [DERIVED]: Number.POSITIVE_INFINITY, [BASE]: 7_000 }, Infinity],
    ["neither", {}, undefined],
  ])("a derived session with executions under %s", (_what, deadlines, expected) => {
    const { asked, latest } = lookup(deadlines, { labels: { [BASE]: { tablet: DERIVED } } });

    expect(latest(DERIVED)).toBe(expected);
    expect(asked.map((entry) => entry.id)).toEqual([DERIVED, BASE]);
  });

  test("a recovery in flight carries no deadline and asks the tracker nothing", () => {
    const { asked, latest } = lookup({ [BASE]: 5_000 }, { recovering: [BASE] });

    expect(latest(BASE)).toBe(Number.POSITIVE_INFINITY);
    expect(asked).toEqual([]);
  });
});
