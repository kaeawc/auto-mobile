import { isRecord } from "./finalizeShared";
import type {
  FinalizeToolResponseContext,
  ObservationArtifactMetadata,
  ObservationArtifactPayload,
} from "./finalizeToolResponse";

export function writeObservationArtifact(
  ctx: FinalizeToolResponseContext,
  observationPayload: unknown,
): ObservationArtifactMetadata {
  return writeJsonArtifact(
    ctx,
    getObservationArtifactPayload(observationPayload),
    observationPayload,
  );
}

/**
 * Keep a diff's compact selector surface and capture metadata inline; only its
 * potentially unbounded body belongs in the artifact (#7217).
 */
export function writeObserveDiffBodyArtifact(
  ctx: FinalizeToolResponseContext,
  observation: Record<string, unknown>,
): Record<string, unknown> {
  const { added, removed, changed, fields, ...inline } = observation;
  delete inline.isDiff;
  const body: Record<string, unknown> = { isDiff: true, added, removed, changed };
  if (fields !== undefined) {
    body.fields = fields;
  }
  return { ...inline, ...writeObservationArtifact(ctx, body) };
}

export function isObserveDiff(observation: unknown): observation is Record<string, unknown> {
  return (
    observation !== null &&
    typeof observation === "object" &&
    (observation as Record<string, unknown>).isDiff === true
  );
}

function getObservationArtifactPayload(observationPayload: unknown): ObservationArtifactPayload {
  if (
    observationPayload &&
    typeof observationPayload === "object" &&
    (observationPayload as Record<string, unknown>).isDiff === true
  ) {
    return "ObserveDiff";
  }
  return "ObserveResult";
}

export function writeJsonArtifact(
  ctx: FinalizeToolResponseContext,
  payload: ObservationArtifactPayload,
  data: unknown,
): ObservationArtifactMetadata {
  return ctx.artifactWriter!.writeJsonArtifact({
    tool: ctx.name,
    payload,
    data,
  });
}

export function artifactNonObservationPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!ctx.artifactWriter || ctx.internal) {
    return undefined;
  }

  switch (ctx.name) {
    case "executePlan":
      return artifactExecutePlanPayload(ctx, payload);
    case "getNetworkGraph":
      return artifactNetworkGraphPayload(ctx, payload);
    default:
      return undefined;
  }
}

function artifactExecutePlanPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let changed = false;
  const nextPayload: Record<string, unknown> = { ...payload };
  if (isRecord(payload.failedStep)) {
    const failureObservation = artifactPlanObservation(
      ctx,
      payload.failedStep.failureObservation,
      "ExecutePlanFailureObservation",
    );
    if (failureObservation) {
      nextPayload.failedStep = { ...payload.failedStep, failureObservation };
      changed = true;
    }
  }

  if (Array.isArray(payload.deviceFailures)) {
    nextPayload.deviceFailures = payload.deviceFailures.map((failure) => {
      if (!isRecord(failure)) {
        return failure;
      }
      const failureObservation = artifactPlanObservation(
        ctx,
        failure.failureObservation,
        "ExecutePlanFailureObservation",
      );
      if (!failureObservation) {
        return failure;
      }
      changed = true;
      return { ...failure, failureObservation };
    });
  }

  if (isRecord(payload.debug) && Array.isArray(payload.debug.steps)) {
    let debugChanged = false;
    const steps = payload.debug.steps.map((step) => {
      if (!isRecord(step) || !isRecord(step.details)) {
        return step;
      }

      let detailsChanged = false;
      let details = step.details;
      const stepObservation = artifactPlanObservation(
        ctx,
        details.stepObservation,
        "ExecutePlanDebugStepObservation",
      );
      if (stepObservation) {
        details = { ...details, stepObservation };
        detailsChanged = true;
      }

      const failureObservation = artifactPlanObservation(
        ctx,
        details.failureObservation,
        "ExecutePlanDebugFailureObservation",
      );
      if (failureObservation) {
        details = { ...details, failureObservation };
        detailsChanged = true;
      }

      if (!detailsChanged) {
        return step;
      }
      debugChanged = true;
      return { ...step, details };
    });

    if (debugChanged) {
      nextPayload.debug = { ...payload.debug, steps };
      changed = true;
    }
  }

  return changed ? nextPayload : undefined;
}

function artifactPlanObservation(
  ctx: FinalizeToolResponseContext,
  observation: unknown,
  payloadPrefix: string,
): Record<string, unknown> | undefined {
  if (!isRecord(observation)) {
    return undefined;
  }

  let changed = false;
  const next: Record<string, unknown> = { ...observation };
  if (observation.viewHierarchy !== undefined) {
    next.viewHierarchy = writeJsonArtifact(
      ctx,
      `${payloadPrefix}ViewHierarchy`,
      observation.viewHierarchy,
    );
    changed = true;
  }
  if (observation.rawViewHierarchy !== undefined) {
    next.rawViewHierarchy = writeJsonArtifact(
      ctx,
      `${payloadPrefix}RawViewHierarchy`,
      observation.rawViewHierarchy,
    );
    changed = true;
  }

  return changed ? next : undefined;
}

function artifactNetworkGraphPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.graph)) {
    return undefined;
  }

  return {
    ...payload,
    graph: writeJsonArtifact(ctx, "NetworkGraph", payload.graph),
    graphSummary: {
      hostCount: payload.graph.length,
    },
  };
}
