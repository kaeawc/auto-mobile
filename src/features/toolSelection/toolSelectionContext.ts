import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionToolSelectionService } from "./SessionToolSelectionService";

export type ToolSelectionContext = {
  routingSessionUuid?: string;
  execution?: {
    executionId: string;
    startTime: number;
  };
  /** Connection-scoped selection profile, independent of device routing. */
  toolSelectionProfileUuid?: string;
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled"> &
    Partial<Pick<SessionToolSelectionService, "setEnabled" | "deleteSession">>;
};

const toolSelectionContext = new AsyncLocalStorage<ToolSelectionContext>();

export const runWithToolSelectionContext = async <T>(
  context: ToolSelectionContext,
  fn: () => Promise<T>,
): Promise<T> => {
  const parent = toolSelectionContext.getStore();
  return toolSelectionContext.run(
    {
      routingSessionUuid: context.routingSessionUuid ?? parent?.routingSessionUuid,
      execution: context.execution ?? parent?.execution,
      toolSelectionProfileUuid:
        context.toolSelectionProfileUuid ?? parent?.toolSelectionProfileUuid,
      sessionToolSelectionService:
        context.sessionToolSelectionService ?? parent?.sessionToolSelectionService,
    },
    fn,
  );
};

export const getToolSelectionContext = (): ToolSelectionContext | undefined =>
  toolSelectionContext.getStore();
