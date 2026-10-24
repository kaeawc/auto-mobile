import { baselineHoldsApp } from "../daemon/sessionBroker/mutations/appInventory";
import type { DeviceBaseline } from "../daemon/sessionBroker/mutations/types";
import {
  FALLBACK_OPAQUE_KEY_PREFIX,
  opaqueForcesFallback,
} from "../daemon/sessionBroker/mutations/types";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { ToolMutation } from "./deviceMutationAdapters";
import { APP_FALLBACK_TOOLS } from "./deviceMutationLifecycleAdapters";

/** What the recorder can tell about the app inventory a session started from. */
export interface AppFallbackEvidence {
  /** The session already journaled that it installed `appId`. */
  sessionInstalled(appId: string): Promise<boolean>;
  /** The device baseline, or null when none is readable. */
  baseline(): Promise<DeviceBaseline | null>;
}

function fallbackTarget(
  mutation: ToolMutation,
): { tool: (typeof APP_FALLBACK_TOOLS)[number]; appId: string | null; keepData: boolean } | null {
  if (!opaqueForcesFallback(mutation)) {
    return null;
  }
  try {
    const parts: unknown = JSON.parse(mutation.key.slice(FALLBACK_OPAQUE_KEY_PREFIX.length));
    const tool = Array.isArray(parts) ? APP_FALLBACK_TOOLS.find((name) => name === parts[0]) : null;
    const appId = Array.isArray(parts) && typeof parts[1] === "string" ? parts[1] : null;
    return tool
      ? {
          tool,
          appId,
          keepData: tool === "uninstallApp" && Array.isArray(parts) && parts[2] === true,
        }
      : null;
  } catch (error) {
    // Another family's opaque intent need not parse as an app key; it is kept as recorded.
    logger.debug(
      `Opaque intent ${mutation.key} is not an app fallback key: ${errorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Drops an app `fallback:` intent when the keep-booted clean already covers it, so the common
 * install, clear, test, uninstall flow does not escalate every reset. An app the baseline did not
 * hold and the session installed is removed (data included) by the clean; anything else, or an
 * unreadable baseline, keeps the intent. Data-kept uninstalls always keep it because removed
 * packages are invisible to the clean inventory.
 */
export async function withoutSessionCoveredFallbacks<Mutation extends ToolMutation>(
  mutations: readonly Mutation[],
  evidence: AppFallbackEvidence,
): Promise<Mutation[]> {
  const kept: Mutation[] = [];
  for (const mutation of mutations) {
    const target = fallbackTarget(mutation);
    if (!target || target.keepData) {
      kept.push(mutation);
      continue;
    }
    const baseline = await evidence.baseline();
    const held =
      baseline && target.appId !== null ? baselineHoldsApp(baseline, target.appId) : undefined;
    const covered =
      held === undefined || target.appId === null
        ? false
        : target.tool === "installApp"
          ? !held
          : !held && (await evidence.sessionInstalled(target.appId));
    if (!covered) {
      kept.push(mutation);
    }
  }
  return kept;
}
