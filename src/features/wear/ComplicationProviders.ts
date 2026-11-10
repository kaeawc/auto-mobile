import { toActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

/**
 * The intent action Wear complication data sources declare. The androidx action
 * (`androidx.wear.watchface.complications.action.COMPLICATION_UPDATE_REQUEST`) returned
 * `No services found` on the API 37 image, while every data source answered this one (#17521).
 */
export const COMPLICATION_PROVIDER_ACTION =
  "android.support.wearable.complications.ACTION_COMPLICATION_UPDATE_REQUEST";

export interface ComplicationProvider {
  /** `<package>/<class>`, as accepted by the debug-surface `--ecn component` extra. */
  component: string;
  packageName: string;
  className: string;
}

export interface ComplicationProviderLister {
  list(signal?: AbortSignal): Promise<ComplicationProvider[]>;
}

const COMMAND_TIMEOUT_MS = 10_000;
const FIELD = /^(\s*)(name|packageName)=(\S+)\s*$/;

/**
 * Parse `cmd package query-services -a <action>` output. Each service prints `name=` then
 * `packageName=` at the indent of the first `name=`; its ApplicationInfo repeats both keys one
 * level deeper, so only fields at the service indent count.
 */
export function parseComplicationProviders(stdout: string): ComplicationProvider[] {
  const fields = stdout.split(/\r?\n/).flatMap((line) => {
    const field = FIELD.exec(line);
    return field ? [{ indent: field[1].length, key: field[2], value: field[3] }] : [];
  });
  const serviceIndent = fields.find((field) => field.key === "name")?.indent;
  const providers = new Map<string, ComplicationProvider>();
  let className: string | undefined;
  for (const { key, value } of fields.filter((f) => f.indent === serviceIndent)) {
    if (key === "name") {
      className = value;
    } else if (className !== undefined) {
      const component = `${value}/${className}`;
      providers.set(component, { component, packageName: value, className });
      className = undefined;
    }
  }
  return [...providers.values()];
}

export class AdbComplicationProviderLister implements ComplicationProviderLister {
  constructor(private readonly adb: AdbCommandRunner) {}

  async list(signal?: AbortSignal): Promise<ComplicationProvider[]> {
    try {
      signal?.throwIfAborted();
      const result = await this.adb.executeCommand(
        `shell cmd package query-services -a ${COMPLICATION_PROVIDER_ACTION}`,
        { timeoutMs: COMMAND_TIMEOUT_MS, signal },
      );
      return parseComplicationProviders(result.stdout);
    } catch (error) {
      throw toActionableError(error, "Failed to list Wear complication providers");
    }
  }
}
