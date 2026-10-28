import { toActionableError } from "../../models/ActionableError";
import type { PrototypeMockBackendRegistry } from "../../features/prototype/PrototypeMockBackendRegistry";
import { MOCK_ORIGIN_SUFFIX } from "../../features/prototype/prototypeMockOrigin";
import { logger } from "../../utils/logger";
import type { PrototypeOutput } from "./types";
import type { prototypeSchema } from "./schemas";
import type { z } from "zod/v4";

export const isMockBackendAction = (
  action: string,
): action is "defineBackend" | "clearBackend" | "backendLog" =>
  ["defineBackend", "clearBackend", "backendLog"].includes(action);

const originOf = (backendId: string): string => `https://${backendId}${MOCK_ORIGIN_SUFFIX}`;

/** Host-local mock backend actions (#14271): no device request, session-scoped state. */
export function mockBackendOutput(
  mocks: PrototypeMockBackendRegistry,
  args: z.infer<typeof prototypeSchema>,
): PrototypeOutput {
  const backendId = args.backendId!;
  try {
    if (args.action === "clearBackend") {
      return {
        success: true,
        backend: { id: backendId, origin: originOf(backendId), cleared: mocks.clear(backendId) },
      };
    }
    if (args.action === "backendLog") {
      const backend = mocks.get(backendId);
      if (backend === undefined) {
        return { success: false, error: `No mock backend "${backendId}" is defined.` };
      }
      return { success: true, backendLog: backend.requestLog(args.since) };
    }
    mocks.define(backendId, args.backend);
    const definition = mocks.get(backendId)!;
    const collections = Object.fromEntries(
      Object.entries(definition.snapshot()).map(([name, items]) => [name, items.length]),
    );
    return {
      success: true,
      backend: {
        id: backendId,
        origin: originOf(backendId),
        collections,
        routes: definition.routeCount,
        faults: definition.faultCount,
      },
    };
  } catch (error) {
    logger.warn("Prototype mock backend action failed", error);
    return {
      success: false,
      error: toActionableError(error, "Mock backend action failed").message,
    };
  }
}
