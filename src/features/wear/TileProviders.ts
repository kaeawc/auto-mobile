import { toActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { TileProviderNotFoundError } from "./TileProviderNotFoundError";
import { TILE_PROVIDER_ACTION } from "./tileProviderAction";

export { TILE_PROVIDER_ACTION, TileProviderNotFoundError };

export interface TileProvider {
  /** `<package>/<class>`, as accepted by the debug-surface `--ecn component` extra. */
  component: string;
  packageName: string;
  className: string;
}

export interface TileProviderLister {
  list(signal?: AbortSignal): Promise<TileProvider[]>;
}

const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Package names are ASCII. Class names are Java identifiers: letters, digits, combining marks,
 * connector punctuation (`_`) and currency symbols (`$`), joined by dots.
 */
const COMPONENT_LINE = /^([A-Za-z0-9_.]+)\/([\p{L}\p{N}\p{M}\p{Pc}\p{Sc}.]+)$/u;

/**
 * Parse `cmd package query-services --components` output: one `<package>/<class>`
 * per line. A `N services found:` header (or any non-component line) is ignored,
 * and no components is a valid empty list. A short `.Class` name is expanded
 * against its package, matching Android's ComponentName flattening.
 */
export function parseTileProviderComponents(stdout: string): TileProvider[] {
  const seen = new Set<string>();
  return stdout
    .split(/\r?\n/)
    .map((line) => COMPONENT_LINE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, packageName, rawClass]) => {
      const className = rawClass.startsWith(".") ? `${packageName}${rawClass}` : rawClass;
      return { component: `${packageName}/${className}`, packageName, className };
    })
    .filter((provider) => {
      if (seen.has(provider.component)) {
        return false;
      }
      seen.add(provider.component);
      return true;
    });
}

/** Normalize a `<package>/<class>` or `<package>/.Class` component for comparison. */
export function normalizeTileComponent(component: string): string {
  const parsed = parseTileProviderComponents(component);
  return parsed.length === 1 ? parsed[0].component : component.trim();
}

export class AdbTileProviderLister implements TileProviderLister {
  constructor(private readonly adb: AdbCommandRunner) {}

  async list(signal?: AbortSignal): Promise<TileProvider[]> {
    try {
      signal?.throwIfAborted();
      const result = await this.adb.executeCommand(
        `shell cmd package query-services --components -a ${TILE_PROVIDER_ACTION}`,
        { timeoutMs: COMMAND_TIMEOUT_MS, signal },
      );
      return parseTileProviderComponents(result.stdout);
    } catch (error) {
      throw toActionableError(error, "Failed to list Wear tile providers");
    }
  }
}

/**
 * Resolve `component` against the device's tile providers before any broadcast,
 * throwing TileProviderNotFoundError when it is not one of them.
 */
export async function requireTileProvider(
  lister: TileProviderLister,
  component: string,
  signal?: AbortSignal,
): Promise<TileProvider> {
  const wanted = normalizeTileComponent(component);
  const providers = await lister.list(signal);
  const match = providers.find((provider) => provider.component === wanted);
  if (!match) {
    throw new TileProviderNotFoundError(
      component,
      providers.map((provider) => provider.component),
    );
  }
  return match;
}
