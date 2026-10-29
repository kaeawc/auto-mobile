/**
 * Orchestration for the persona robustness harness (#14061): replay one plan under the baseline
 * and each perturbation, reset the device after every replay, then optionally re-run failing
 * personas one facet at a time to attribute the failure. All device I/O goes through a
 * `DriveClient`, so tests drive it with a fake.
 */
import { getDeviceSessionIdFromResult } from "../../src/daemon/deviceSessionResult";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { isCliToolFailure } from "../../src/cli/index";
import { OEM_PERSONA_CATALOG_VERSION } from "../../src/features/utility/OemPersonas";
import { readEnvelope, type DriveClient, type DriveStep } from "../mcp-drive";
import { facetAblations, isOemPersonaId, resetStep, type Perturbation } from "./matrix";
import {
  aggregateVerdict,
  attribute,
  errorScore,
  isSuccess,
  scoreReplay,
  type Attribution,
  type ReplayScore,
  type Verdict,
} from "./score";

export interface HarnessOptions {
  planName: string;
  planContent: string;
  appId: string;
  baseline: Perturbation;
  perturbations: Perturbation[];
  repeats: number;
  /** Re-run each failing persona one facet at a time. */
  ablate: boolean;
  /** Existing device session; when absent the harness mints one with getAndroid. */
  session?: string;
  /** getAndroid arguments used when minting a session. */
  acquireArgs?: Record<string, unknown>;
}

export interface HarnessDeps {
  client: DriveClient;
  log(message: string): void;
  now(): number;
}

export interface PerturbationResult {
  id: string;
  kind: Perturbation["kind"];
  description: string;
  facets: string[];
  parentId?: string;
  runs: ReplayScore[];
  verdict: Verdict;
  attribution: Attribution;
  durationMs: number;
}

export interface RobustnessReport {
  planName: string;
  appId: string;
  personaCatalogVersion: number;
  repeats: number;
  session?: string;
  baseline: PerturbationResult;
  results: PerturbationResult[];
  ablations: PerturbationResult[];
  /** Set when the harness stopped early, with the reason; later perturbations did not run. */
  aborted?: string;
}

interface StepOutcome {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

class HarnessAbort extends Error {}

async function call(
  client: DriveClient,
  step: DriveStep,
  session: string | undefined,
): Promise<StepOutcome & { envelope?: unknown }> {
  const args = session ? { ...step.args, sessionUuid: session } : step.args;
  let envelope: unknown;
  try {
    envelope = await client.callTool(step.tool, args);
  } catch (error) {
    return { ok: false, error: `${step.tool} threw: ${errorMessage(error)}` };
  }
  const { payload, errorText } = readEnvelope(envelope);
  const ok = !errorText && !isCliToolFailure(envelope);
  return {
    ok,
    payload,
    envelope,
    ...(ok ? {} : { error: `${step.tool}: ${errorText ?? "tool reported success:false"}` }),
  };
}

/** Tools the harness calls; several are off by default, so the session declares them. */
export const HARNESS_TOOLS = [
  "manufacturerProfile",
  "displayProfile",
  "killProfile",
  "keyboard",
  "executePlan",
] as const;

async function acquireSession(options: HarnessOptions, deps: HarnessDeps): Promise<string> {
  if (options.session) {
    const enabled = await call(
      deps.client,
      { tool: "setToolEnabled", args: { toolNames: [...HARNESS_TOOLS], enabled: true } },
      options.session,
    );
    if (!enabled.ok) {
      throw new HarnessAbort(`could not enable the harness tools: ${enabled.error}`);
    }
    return options.session;
  }
  const outcome = await call(
    deps.client,
    {
      tool: "getAndroid",
      args: { ...options.acquireArgs, enableTools: [...HARNESS_TOOLS] },
    },
    undefined,
  );
  const session = outcome.envelope ? getDeviceSessionIdFromResult(outcome.envelope) : undefined;
  if (!outcome.ok || !session) {
    throw new HarnessAbort(`could not acquire an Android device: ${outcome.error ?? "no session"}`);
  }
  deps.log(`session: ${session}`);
  return session;
}

/**
 * A displayProfile or manufacturerProfile apply can succeed while an effect is missing (an
 * overlay the emulator lacks reports `unsupported`, a partial persona `partial`). The replay
 * would then run without the perturbation it reports, so anything but `applied` is a harness
 * error. Tools that report no status are judged by success alone.
 */
export function incompleteApplication(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const status = payload?.status;
  return typeof status === "string" && status !== "applied"
    ? `perturbation reported status ${status}`
    : undefined;
}

/** One replay: apply, run the plan, then always reset. A failed reset aborts the harness. */
async function replay(
  perturbation: Perturbation,
  options: HarnessOptions,
  session: string,
  deps: HarnessDeps,
): Promise<ReplayScore> {
  let score: ReplayScore | undefined;
  for (const step of perturbation.apply) {
    const applied = await call(deps.client, step, session);
    const incomplete = incompleteApplication(applied.payload);
    if (!applied.ok || incomplete) {
      score = errorScore(`apply failed: ${applied.error ?? incomplete}`);
      break;
    }
  }
  if (!score) {
    const executed = await call(
      deps.client,
      { tool: "executePlan", args: { planContent: options.planContent, platform: "android" } },
      session,
    );
    score = executed.payload
      ? scoreReplay(executed.payload)
      : errorScore(executed.error ?? "executePlan returned no payload");
  }
  const reset = await call(deps.client, resetStep(options.appId), session);
  if (!reset.ok) {
    throw new HarnessAbort(
      `reset after ${perturbation.id} failed, so the device state is unknown: ${reset.error}`,
    );
  }
  return score;
}

async function runPerturbation(
  perturbation: Perturbation,
  options: HarnessOptions,
  session: string,
  deps: HarnessDeps,
): Promise<Omit<PerturbationResult, "attribution">> {
  const started = deps.now();
  const runs: ReplayScore[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    const score = await replay(perturbation, options, session, deps);
    runs.push(score);
    const step = score.failedStep
      ? ` at step ${score.failedStep.stepIndex} (${score.failedStep.tool})`
      : "";
    deps.log(`${perturbation.id} [${repeat}/${options.repeats}]: ${score.outcome}${step}`);
  }
  return {
    id: perturbation.id,
    kind: perturbation.kind,
    description: perturbation.description,
    facets: perturbation.facets,
    ...(perturbation.parentId ? { parentId: perturbation.parentId } : {}),
    runs,
    verdict: aggregateVerdict(runs),
    durationMs: deps.now() - started,
  };
}

function singleFacet(result: Pick<PerturbationResult, "kind" | "facets">): boolean {
  return (result.kind === "display" || result.kind === "facet") && result.facets.length === 1;
}

export async function runHarness(
  options: HarnessOptions,
  deps: HarnessDeps,
): Promise<RobustnessReport> {
  if (!Number.isInteger(options.repeats) || options.repeats < 1) {
    throw new Error("repeats must be a positive integer");
  }
  const raw: Array<Omit<PerturbationResult, "attribution">> = [];
  const rawAblations: Array<Omit<PerturbationResult, "attribution">> = [];
  let baselineRaw: Omit<PerturbationResult, "attribution"> | undefined;
  let session: string | undefined;
  let aborted: string | undefined;
  try {
    session = await acquireSession(options, deps);
    // Start from a clean device: undo anything a previous run left applied.
    const initialReset = await call(deps.client, resetStep(options.appId), session);
    if (!initialReset.ok) {
      throw new HarnessAbort(`initial reset failed: ${initialReset.error}`);
    }
    baselineRaw = await runPerturbation(options.baseline, options, session, deps);
    for (const perturbation of options.perturbations) {
      raw.push(await runPerturbation(perturbation, options, session, deps));
    }
    if (options.ablate && isSuccess(baselineRaw.verdict)) {
      for (const result of raw) {
        if (result.kind !== "persona" || isSuccess(result.verdict) || !isOemPersonaId(result.id)) {
          continue;
        }
        for (const facet of facetAblations(result.id, options.appId)) {
          rawAblations.push(await runPerturbation(facet, options, session, deps));
        }
      }
    }
  } catch (error) {
    if (!(error instanceof HarnessAbort)) {
      throw error;
    }
    aborted = error.message;
    deps.log(`aborted: ${aborted}`);
  }

  const baselineVerdict: Verdict = baselineRaw?.verdict ?? "error";
  const withAttribution = (
    result: Omit<PerturbationResult, "attribution">,
    ablation?: { results: PerturbationResult[]; expected: number },
  ): PerturbationResult => ({
    ...result,
    attribution:
      result.kind === "baseline"
        ? { kind: "none" }
        : attribute({
            verdict: result.verdict,
            facets: result.facets,
            singleFacet: singleFacet(result),
            baselineVerdict,
            ...(ablation
              ? { ablation: ablation.results, expectedAblations: ablation.expected }
              : {}),
          }),
  });
  const ablations = rawAblations.map((result) => withAttribution(result));
  const results = raw.map((result) => {
    const own = ablations.filter((entry) => entry.parentId === result.id);
    const ablated = options.ablate && result.kind === "persona" && isOemPersonaId(result.id);
    return withAttribution(
      result,
      ablated
        ? { results: own, expected: facetAblations(result.id, options.appId).length }
        : undefined,
    );
  });
  const baseline = baselineRaw
    ? withAttribution(baselineRaw)
    : {
        id: options.baseline.id,
        kind: options.baseline.kind,
        description: options.baseline.description,
        facets: options.baseline.facets,
        runs: [],
        verdict: "error" as const,
        attribution: { kind: "none" as const },
        durationMs: 0,
      };
  return {
    planName: options.planName,
    appId: options.appId,
    personaCatalogVersion: OEM_PERSONA_CATALOG_VERSION,
    repeats: options.repeats,
    ...(session ? { session } : {}),
    baseline,
    results,
    ablations,
    ...(aborted ? { aborted } : {}),
  };
}
