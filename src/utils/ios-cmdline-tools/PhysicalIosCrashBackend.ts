import type { ExecResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type {
  IosCrashBackend,
  IosCrashCommandOptions,
  IosCrashKillOptions,
} from "./IosCrashBackend";

export const PHYSICAL_IOS_CRASH_UNSUPPORTED_MESSAGE =
  "crashApp is not supported on physical iOS devices; " +
  "AutoMobile will not fall back to normal termination";

export class PhysicalIosCrashBackend implements IosCrashBackend {
  readonly kind = "physical";

  listProcesses(_options: IosCrashCommandOptions): Promise<ExecResult> {
    return Promise.reject(new ActionableError(PHYSICAL_IOS_CRASH_UNSUPPORTED_MESSAGE));
  }

  killProcess(_options: IosCrashKillOptions): Promise<ExecResult> {
    return Promise.reject(new ActionableError(PHYSICAL_IOS_CRASH_UNSUPPORTED_MESSAGE));
  }

  readCrashLog(_options: IosCrashCommandOptions): Promise<ExecResult> {
    return Promise.reject(new ActionableError(PHYSICAL_IOS_CRASH_UNSUPPORTED_MESSAGE));
  }
}
