import { execFileAsync as sharedExecFileAsync } from "../../utils/HostCommandExecutor";

import { DefaultSimCtlClientFactory } from "./DefaultSimCtlClientFactory";

import { ExecFileAsyncFn, SimCtlClientFactory } from "./PerformanceMonitorTypes";

export const defaultExecFileAsync: ExecFileAsyncFn = async (file, args) => {
  const result = await sharedExecFileAsync(file, args);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

/**
 * Singleton instance of the default factory.
 */
export const defaultSimCtlClientFactory: SimCtlClientFactory = new DefaultSimCtlClientFactory();
