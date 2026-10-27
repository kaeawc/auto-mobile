import type { PrototypeEventCoordinator } from "../../features/prototype/PrototypeEventCoordinator";
import { statusOutput } from "./inspection";
import { z } from "zod/v4";
import { PrototypeTestSessionRecorder } from "../../features/prototype/testSession/PrototypeTestSessionRecorder";
import { prototypeScreenLabel } from "../../features/prototype/testSession/prototypeTestSessionEvent";
import { prototypeSecureKeys } from "../../features/prototype/testSession/prototypeTestSessionSpec";
import { PrototypeTestSessionRepository } from "../../db/prototypeTestSessionRepository";
import type {
  PrototypeScope,
  PrototypeStatusStore,
} from "../../features/prototype/PrototypeStatusStore";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { defaultTimer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { toActionableError } from "../../models/ActionableError";
import type { PrototypeToolDependencies, PrototypeOutput } from "./types";
import type { prototypeSchema } from "./schemas";

/** Validates the host-built report as JSON for the output envelope; not a tool argument. */
const hostReportSchema = z.json();

export function createTestSessionRecorder(
  deps: PrototypeToolDependencies,
  store: PrototypeStatusStore,
): PrototypeTestSessionRecorder {
  const shown = (scope: PrototypeScope, id: string) => store.shownSpecs.read(scope.deviceId, id);
  return new PrototypeTestSessionRecorder({
    store: deps.testSessionStore ?? new PrototypeTestSessionRepository(),
    timer: deps.clock ?? deps.timer ?? defaultTimer,
    ids: deps.idGenerator ?? defaultIdGenerator,
    secureKeys: (scope, id) => {
      const read = shown(scope, id);
      return read.kind === "known" ? prototypeSecureKeys(read.spec) : new Set(["*"]);
    },
    startScreen: (scope, id) =>
      prototypeScreenLabel(store.status(scope).prototypes.find((p) => p.id === id)?.stacks),
    deadTapsEnabled: (scope, id) => {
      const read = shown(scope, id);
      if (read.kind !== "known") {
        return false;
      }
      const window = read.spec.window;
      return (
        window !== null &&
        typeof window === "object" &&
        "deadTaps" in window &&
        window.deadTaps === true
      );
    },
  });
}
export const isTestSessionAction = (
  action: string,
): action is "testSessionBegin" | "testSessionEnd" | "testSessionReport" =>
  ["testSessionBegin", "testSessionEnd", "testSessionReport"].includes(action);
export async function testSessionAction(
  recorder: PrototypeTestSessionRecorder,
  scope: PrototypeScope,
  args: z.infer<typeof prototypeSchema>,
): Promise<PrototypeOutput> {
  try {
    const result =
      args.action === "testSessionBegin"
        ? await recorder.begin(scope, args.id!, args)
        : args.action === "testSessionEnd"
          ? await recorder.end(scope, args.id!)
          : await recorder.report(scope, args);
    const s = result.session;
    return {
      success: true,
      testSession: {
        id: s.test_session_id,
        prototypeId: s.prototype_id,
        deviceId: s.device_id,
        status: s.status,
        ...(s.cohort === null ? {} : { cohort: s.cohort }),
        ...(s.goal === null ? {} : { goal: s.goal }),
        startedAt: s.started_at_ms,
        ...(s.ended_at_ms === null ? {} : { endedAt: s.ended_at_ms }),
        eventCount: result.eventCount,
        droppedCount: s.dropped_count,
        deadTaps: result.deadTaps,
      },
      ...("report" in result
        ? { report: hostReportSchema.parse(result.report), markdown: result.markdown }
        : {}),
      ...("warning" in result ? { warning: result.warning } : {}),
    };
  } catch (error) {
    logger.warn("Prototype test session action failed", error);
    return {
      success: false,
      error: toActionableError(error, "Prototype test session failed").message,
    };
  }
}

export function isHostLocalPrototypeAction(
  action: string,
): action is "status" | "testSessionBegin" | "testSessionEnd" | "testSessionReport" {
  return action === "status" || isTestSessionAction(action);
}
export function hostLocalPrototypeOutput(
  host: {
    recorder: PrototypeTestSessionRecorder;
    store: PrototypeStatusStore;
    events: PrototypeEventCoordinator;
  },
  scope: PrototypeScope,
  args: z.infer<typeof prototypeSchema>,
): PrototypeOutput | Promise<PrototypeOutput> {
  return args.action === "status"
    ? { success: true, ...statusOutput(host.store, host.events, scope, { deviceDark: "cached" }) }
    : testSessionAction(host.recorder, scope, args);
}
