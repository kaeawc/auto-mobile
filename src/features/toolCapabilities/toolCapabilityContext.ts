import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionToolProfileService } from "./SessionToolProfileService";

type ToolCapabilityContext = {
  sessionUuid?: string;
  sessionToolProfileService?: Pick<SessionToolProfileService, "isEnabled">;
};

const toolCapabilityContext = new AsyncLocalStorage<ToolCapabilityContext>();

export const runWithToolCapabilityContext = async <T>(
  context: ToolCapabilityContext,
  fn: () => Promise<T>
): Promise<T> => {
  const parent = toolCapabilityContext.getStore();
  return toolCapabilityContext.run({
    sessionUuid: context.sessionUuid ?? parent?.sessionUuid,
    sessionToolProfileService: context.sessionToolProfileService ?? parent?.sessionToolProfileService,
  }, fn);
};

export const getToolCapabilityContext = (): ToolCapabilityContext | undefined => {
  return toolCapabilityContext.getStore();
};
