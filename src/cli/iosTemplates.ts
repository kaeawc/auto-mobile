import type { TemplateCreationDependencies } from "../features/iosTemplates/SimulatorCreationService";
import { parseArgs } from "node:util";
import { toActionableError } from "../models/ActionableError";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { setProcessShutdownExitCode, setProcessShutdownHandler } from "../processLifecycle";
import type { SimulatorTemplateKey } from "../utils/ios-cmdline-tools/SimulatorTemplateKey";
import type { TemplateCleanupOptions } from "../features/iosTemplates/SimulatorTemplateCleanup";
export const IOS_TEMPLATES_USAGE =
  "Usage: auto-mobile --ios-templates build --runtime <identifier> --device-type <identifier> | clean (--all | --stale | --runtime <identifier> [--device-type <identifier>]) [--force]";
export type IosTemplatesArgs = {
  action: "build" | "clean";
  all: boolean;
  force: boolean;
  stale?: boolean;
  runtime?: string;
  deviceType?: string;
};
export function parseIosTemplatesArgs(args: string[]): IosTemplatesArgs {
  const [action, ...rest] = args;
  if (action !== "build" && action !== "clean") {
    throw new ActionableError(IOS_TEMPLATES_USAGE);
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        stale: { type: "boolean" },
        all: { type: "boolean" },
        force: { type: "boolean" },
        runtime: { type: "string" },
        "device-type": { type: "string" },
      },
    }));
  } catch (error) {
    throw toActionableError(error, IOS_TEMPLATES_USAGE);
  }
  const parsed: IosTemplatesArgs = {
    action,
    all: values.all ?? false,
    force: values.force ?? false,
    ...(values.stale ? { stale: true } : {}),
    runtime: values.runtime,
    deviceType: values["device-type"],
  };
  validateTarget(parsed);
  return parsed;
}
function validateTarget(parsed: IosTemplatesArgs): void {
  if (parsed.action === "build" && (parsed.all || parsed.force)) {
    throw new ActionableError(IOS_TEMPLATES_USAGE);
  }
  const selectors =
    Number(parsed.all) + Number(Boolean(parsed.stale)) + Number(Boolean(parsed.runtime));
  if (
    selectors !== 1 ||
    (parsed.deviceType && !parsed.runtime) ||
    (parsed.action === "build" && (!parsed.deviceType || parsed.stale))
  ) {
    throw new ActionableError(IOS_TEMPLATES_USAGE);
  }
}
/** Exit code of a command ended by SIGINT, by shell convention (128 + 2). */
export const IOS_TEMPLATES_INTERRUPTED_EXIT_CODE = 130;

export interface IosTemplatesCommandDependencies {
  platform: NodeJS.Platform;
  /**
   * Runs `listener` when the process is asked to stop, and keeps the process alive until it
   * settles: the process-wide SIGINT handler would otherwise exit 0 before any cleanup (#15312).
   */
  onInterrupt(listener: () => Promise<void>): void;
  write(line: string): void;
  resolveKey(runtime: string, deviceType: string): Promise<SimulatorTemplateKey>;
  build(key: SimulatorTemplateKey, signal?: AbortSignal): Promise<unknown>;
  clean(options: TemplateCleanupOptions): Promise<void>;
}
async function defaultDependencies(): Promise<IosTemplatesCommandDependencies> {
  const { createTemplateMaintenance } =
    await import("../features/iosTemplates/defaultSimulatorCreationService");
  const { dependencies, cleanup } = createTemplateMaintenance();
  return {
    platform: process.platform,
    onInterrupt: (listener) => {
      setProcessShutdownHandler(async () => {
        setProcessShutdownExitCode(IOS_TEMPLATES_INTERRUPTED_EXIT_CODE);
        await listener();
      });
    },
    write: (line) => console.log(line),
    build: (key, signal) => dependencies.builder.build(key, signal),
    clean: (options) => cleanup.clean(options),
    resolveKey: (runtime, deviceType) =>
      resolveTemplateMaintenanceKey(dependencies, runtime, deviceType),
  };
}
export async function runIosTemplatesCommand(
  args: string[],
  deps?: IosTemplatesCommandDependencies,
): Promise<number> {
  try {
    if (args.includes("--help") || args.includes("-h")) {
      (deps?.write ?? console.log)(IOS_TEMPLATES_USAGE);
      return 0;
    }
    const parsed = parseIosTemplatesArgs(args);
    if ((deps?.platform ?? process.platform) !== "darwin") {
      throw new ActionableError("iOS templates require macOS.");
    }
    const resolved = deps ?? (await defaultDependencies());
    return await executeTemplateCommand(parsed, resolved);
  } catch (error) {
    logger.warn(`iOS template command failed: ${errorMessage(error)}`, error);
    (deps?.write ?? console.error)(errorMessage(error));
    return 1;
  }
}

async function executeTemplateCommand(
  parsed: IosTemplatesArgs,
  resolved: IosTemplatesCommandDependencies,
): Promise<number> {
  const key = await commandKey(parsed, resolved);
  if (parsed.action === "build" && key) {
    const { result, interrupted } = await buildInterruptibly(resolved, key);
    if (interrupted) {
      resolved.write(JSON.stringify({ result: "interrupted" }));
      return IOS_TEMPLATES_INTERRUPTED_EXIT_CODE;
    }
    resolved.write(JSON.stringify({ result }));
    return result === "ready" ? 0 : 1;
  }
  const target = key
    ? { key }
    : parsed.stale
      ? { stale: true as const }
      : parsed.runtime
        ? { runtime: parsed.runtime }
        : { all: true as const };
  await resolved.clean({ ...target, force: parsed.force });
  resolved.write(JSON.stringify({ result: "cleaned" }));
  return 0;
}

async function commandKey(
  parsed: IosTemplatesArgs,
  deps: IosTemplatesCommandDependencies,
): Promise<SimulatorTemplateKey | undefined> {
  return parsed.runtime && parsed.deviceType
    ? deps.resolveKey(parsed.runtime, parsed.deviceType)
    : undefined;
}

async function buildInterruptibly(
  deps: IosTemplatesCommandDependencies,
  key: SimulatorTemplateKey,
): Promise<{ result: unknown; interrupted: boolean }> {
  const controller = new AbortController();
  let settled: Promise<unknown> = Promise.resolve();
  deps.onInterrupt(async () => {
    controller.abort(new Error("Template build interrupted"));
    // The builder's own abort path removes the partial simulator and releases the lock.
    await settled;
  });
  const run = deps.build(key, controller.signal);
  settled = run.catch((error: unknown) => {
    logger.debug(`iOS template build ended with an error: ${errorMessage(error)}`);
  });
  const result = await run;
  return { result, interrupted: controller.signal.aborted };
}

export async function resolveTemplateMaintenanceKey(
  dependencies: TemplateCreationDependencies,
  runtime: string,
  deviceType: string,
): Promise<SimulatorTemplateKey> {
  const catalog = await dependencies.client.getCatalogChecked();
  if (!catalog.deviceTypes.some((entry) => entry.identifier === deviceType)) {
    throw new ActionableError(`Unknown simulator device type ${deviceType}`);
  }
  const match = catalog.runtimes.find((entry) => entry.identifier === runtime);
  if (!match) {
    throw new ActionableError(
      `Runtime ${runtime} is not installed. List installed simulator runtimes first.`,
    );
  }
  return {
    runtime,
    deviceType,
    runtimeBuild: match.buildversion,
    xcodeBuild: await dependencies.xcode.readBuild(),
    profile: dependencies.profile(),
  };
}
