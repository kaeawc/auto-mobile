import { defaultDaemonContext } from "../../../daemon/daemonContext";
import { ActionableError } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { defaultTimer } from "../../../utils/SystemTimer";
import { carryToolFailureMark } from "../../../utils/toolFailureSignal";
import { stringifyToolResponse } from "../../../utils/toolUtils";
import { unregisterDirectSession } from "../../../utils/directSessionDeviceRegistry";
import { isDeviceSessionAcquisitionTool } from "../../../daemon/deviceSessionResult";
import type { McpServerOptions } from "../../index";
import { ToolRegistry } from "../../toolRegistry";
import {
  applyToolSelection,
  assertUserConfigurableToolNames,
  listEnabledToolNames,
  SET_TOOL_ENABLED_TOOL_NAME,
} from "../../toolSelectionTools";

/**
 * Fail a `getAndroid`/`getApple` call whose request was cancelled while its
 * post-acquisition enrichment ran. The client discards this response, so the
 * handler still fails the call — but it deliberately releases NOTHING in daemon
 * mode. The pool publishes a minted autolock session to the MCP connection
 * BEFORE enrichment runs (`DevicePool.autolockDevice` sets
 * `mcpSessionAutolockMap` ahead of the return), so by the time this fires the
 * session may already be resolved by a sibling acquisition or by any ordinary
 * device tool on the same connection; an eager release here would strand that
 * caller and idle the device underneath it. A session nobody actually picks up
 * is collected by the `missing-first-heartbeat` reap in
 * `src/daemon/sessionManager.ts` (grace before the first heartbeat, then
 * `cleanupExpiredSessions`), which is the backstop this path relies on.
 */
export function failCancelledAcquisition(acquiredSessionUuid: string): never {
  if (!defaultDaemonContext.isInitialized()) {
    // Direct (non-daemon) mode has no SessionManager and no reap, and it has no
    // reuse path either: `bindBootedDeviceSession` always mints a fresh UUID and
    // registers a process-local mapping, so dropping that mapping needs no
    // ownership information and can strand nobody.
    unregisterDirectSession(acquiredSessionUuid);
  }
  throw new ActionableError("MCP request was cancelled during acquisition.");
}

/**
 * The `enableTools` a device-acquisition call declared (#6869). The three
 * acquisition tools advertise the field (`enableToolsSchemaField` in
 * `src/server/toolSelectionTools.ts`); their handlers ignore it, because the
 * grant is applied here — against the session the handler MINTS, which only the
 * result carries.
 */
export function resolveRequestedEnableTools(toolName: string, parsedParams: unknown): string[] {
  if (
    !isDeviceSessionAcquisitionTool(toolName) ||
    !parsedParams ||
    typeof parsedParams !== "object"
  ) {
    return [];
  }
  const requested = (parsedParams as { enableTools?: unknown }).enableTools;
  if (!Array.isArray(requested) || requested.length === 0) {
    return [];
  }
  const names = requested.filter((name): name is string => typeof name === "string");
  // Reject an unknown or non-configurable name BEFORE the device work starts. A
  // caller that misspelled one capability should not pay for a boot and a
  // session mint to find out.
  assertUserConfigurableToolNames(names);
  return names;
}

/**
 * The response field that states a lost `enableTools` declaration — empty when
 * the declaration landed, so it can always be spread into an enrichment.
 */
type CapabilityDeclarationResult = {
  enableToolsError?: string;
  skipped?: import("../../toolSelectionTools").SkippedToolSelection[];
};

/**
 * Grant the declared capabilities against the session an acquisition handler
 * MINTED (only its result carries that UUID), and refresh discovery.
 *
 * Returns the message to report when the grant did NOT land (#6886 review).
 * Folding this failure into the surrounding enrichment catch made a rejected
 * capability write indistinguishable from a successful acquisition, so the
 * caller's next call hit a tool that was never enabled with nothing in the
 * response to explain it. The device is acquired and the session minted by the
 * time this runs, so neither may be discarded — the failure is reported as an
 * explicit `enableToolsError` field on an otherwise intact acquisition result.
 */
export async function applyAcquisitionToolSelection(
  service: McpServerOptions["sessionToolSelectionService"],
  sessionUuid: string,
  enableTools: readonly string[],
): Promise<CapabilityDeclarationResult> {
  if (enableTools.length === 0) {
    return {};
  }
  try {
    const selection = await applyToolSelection(service, sessionUuid, enableTools, true);
    if (selection.requested.length > 0) {
      ToolRegistry.notifyToolSelectionChanged();
    }
    return selection.skipped.length > 0 ? { skipped: selection.skipped } : {};
  } catch (error) {
    const enableToolsError =
      `Could not enable ${enableTools.join(", ")} for session ${sessionUuid}: ` +
      `${errorMessage(error)}. The device session is usable; re-declare the ` +
      `capabilities with ${SET_TOOL_ENABLED_TOOL_NAME}.`;
    logger.warn(`[MCP] ${enableToolsError}`, error);
    return { enableToolsError };
  }
}

/**
 * Report a lost capability declaration on its own, for the path where the
 * optional enabled/gated report could not be built either (#6886 review). A
 * successful declaration leaves the result untouched.
 */
function withCapabilityDeclarationFailure<
  T extends { content: Array<{ type: string; text?: string }> },
>(result: T, failure: CapabilityDeclarationResult): T {
  return failure.enableToolsError || failure.skipped
    ? enrichAcquisitionResult(result, failure)
    : result;
}

/**
 * provisionDevice mints a session too, so it accepts `enableTools` and reports
 * the resulting `enabledTools` (#6869). It deliberately does NOT reuse the
 * getAndroid/getApple discovery path: that one also computes `gatedTools` and
 * fails a cancelled acquisition, neither of which is part of provisionDevice's
 * existing contract. The device is provisioned and the session minted by the
 * time this runs, so a failed capability report must not discard either.
 *
 * The RETAINED session — not `isError` — is what makes this an acquisition
 * (#6886 review). When optional resource configuration fails, provisionDevice
 * deliberately returns `isError: true` alongside a usable `sessionUuid`
 * (`createProvisionDeviceResponse` in `src/server/deviceTools.ts`), and
 * `DaemonMcpProxy` binds that session; gating on `isError` left the caller
 * bound to a live session with none of its declared capabilities and neither
 * `enabledTools` nor `enableToolsError` to say so. A truly failed acquisition
 * mints nothing, so `!sessionUuid` still grants nothing.
 */
export async function enrichProvisionDeviceResult<
  T extends { content: Array<{ type: string; text?: string }> },
>(
  toolName: string,
  result: T,
  sessionUuid: string | undefined,
  service: McpServerOptions["sessionToolSelectionService"],
  {
    enableTools,
    connectionProfileUuid,
  }: { enableTools: readonly string[]; connectionProfileUuid: string | undefined },
): Promise<T> {
  if (toolName !== "provisionDevice" || !sessionUuid) {
    return result;
  }
  const failure = await applyAcquisitionToolSelection(service, sessionUuid, enableTools);
  try {
    return enrichAcquisitionResult(result, {
      // The connection profile is the other half of the union `tools/list` and
      // the call gate apply, and the session this call just minted carries no
      // override of its own — so a capability enabled on the profile is
      // callable and belongs in this report (#6886 review).
      enabledTools: await listEnabledToolNames(
        service,
        [sessionUuid],
        connectionProfileUuid,
        [],
        undefined,
      ),
      ...failure,
    });
  } catch (error) {
    logger.warn("[MCP] Could not enrich provisionDevice with enabled tools", { error });
    // A failed capability declaration still has to reach the caller even when
    // the optional enabled-set report cannot be built (#6886 review).
    return withCapabilityDeclarationFailure(result, failure);
  }
}

/**
 * Merge server-computed session fields (`gatedTools`, `enabledTools`) into an
 * acquisition result, in both the text envelope and `structuredContent`.
 */
export function enrichAcquisitionResult<
  T extends { content: Array<{ type: string; text?: string }> },
>(result: T, fields: Record<string, unknown>): T {
  let enriched = false;
  return carryToolFailureMark(result, {
    ...result,
    content: result.content.map((item: { type: string; text?: string }) => {
      if (enriched || item.type !== "text" || typeof item.text !== "string") {
        return item;
      }
      enriched = true;
      return { ...item, text: stringifyToolResponse({ ...JSON.parse(item.text), ...fields }) };
    }),
    ...((result as { structuredContent?: Record<string, unknown> }).structuredContent
      ? {
          structuredContent: {
            ...(result as { structuredContent?: Record<string, unknown> }).structuredContent,
            ...fields,
          },
        }
      : {}),
  });
}

export async function awaitWithCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw new ActionableError("MCP request was cancelled during acquisition.");
  }
  try {
    return await raceWithDeadline(promise, {
      timer: defaultTimer,
      signal,
      label: "MCP request acquisition",
    });
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      throw new ActionableError("MCP request was cancelled during acquisition.");
    }
    throw error;
  }
}

function isDeviceAcquiringTool(toolName: string): boolean {
  return toolName === "getAndroid" || toolName === "getApple" || toolName === "startDevice";
}

export interface AcquiredSessionEnrichmentInput<T> {
  readonly toolName: string;
  readonly result: T;
  readonly acquiredSessionUuid: string | undefined;
  readonly requestedEnableTools: readonly string[];
  readonly sessionToolSelectionService: McpServerOptions["sessionToolSelectionService"];
  readonly listSessionTools: (sessionUuid: string) => Promise<{ tools: Array<{ name: string }> }>;
  readonly requestSignal: AbortSignal | undefined;
}

/**
 * Post-acquisition stage for `getAndroid` / `getApple` / `startDevice`: apply
 * the caller's `enableTools`, then report the session's gated and enabled tool
 * names. Any other tool, a failed acquisition, or one that minted no session
 * passes through untouched.
 *
 * The returned session is evaluated directly: a seeded transport may retain its
 * old binding, and a concurrent acquisition may publish another one. The same
 * route/label union as tools/list is reused, without publishing yet.
 */
export async function enrichAcquiredSession<
  T extends { content: Array<{ type: string; text?: string }>; isError?: boolean },
>(input: AcquiredSessionEnrichmentInput<T>): Promise<T> {
  const { toolName, acquiredSessionUuid, requestSignal } = input;
  let result = input.result;
  if (!isDeviceAcquiringTool(toolName) || result?.isError || !acquiredSessionUuid) {
    return result;
  }
  let acquisitionEnrichmentCancelled = false;
  // #6869: the caller's `enableTools` declaration lands BEFORE discovery, so the
  // gatedTools/enabledTools pair below reports the session as the caller's next
  // call will find it. #6886 review: a failure here is reported as
  // `enableToolsError` rather than swallowed by the enrichment catch below, which
  // made a lost declaration look like a plain success, while still never
  // stranding the session the handler just minted.
  const capabilityFailure = await applyAcquisitionToolSelection(
    input.sessionToolSelectionService,
    acquiredSessionUuid,
    input.requestedEnableTools,
  );
  try {
    const listed = new Set(
      (
        await awaitWithCancellation(input.listSessionTools(acquiredSessionUuid), requestSignal)
      ).tools.map((tool) => tool.name),
    );
    const configurable = ToolRegistry.getAllTools()
      .filter((tool) => ToolRegistry.isUserConfigurableTool(tool.name))
      .map((tool) => tool.name)
      .sort();
    const gatedTools = configurable.filter((name) => !listed.has(name));
    const enabledTools = configurable.filter((name) => listed.has(name));
    result = enrichAcquisitionResult(result, {
      gatedTools,
      enabledTools,
      ...capabilityFailure,
    });
  } catch (error) {
    acquisitionEnrichmentCancelled ||= Boolean(requestSignal?.aborted);
    // Acquisition already succeeded. Preserve its session handle so the proxy
    // can bind and heartbeat it even if optional discovery fails.
    logger.warn("[MCP] Could not enrich acquisition with gated tools", { tool: toolName, error });
    // A failed capability declaration is not optional detail; report it even
    // when the gated/enabled pair cannot be computed.
    result = withCapabilityDeclarationFailure(result, capabilityFailure);
  }
  // Scoped to the acquisition enrichment on purpose. At the top level this ran
  // for EVERY tool, so a cancellation landing while any handler was finishing
  // discarded that handler's complete, correct result and replaced it with an
  // error naming an acquisition the tool never performed. A non-acquisition
  // tool keeps its result; a genuine cancellation is still classified by the
  // caller's catch.
  if (acquisitionEnrichmentCancelled || requestSignal?.aborted) {
    failCancelledAcquisition(acquiredSessionUuid);
  }
  return result;
}
