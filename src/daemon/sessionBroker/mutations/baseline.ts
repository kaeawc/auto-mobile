import { isDeepStrictEqual } from "node:util";
import {
  DEVICE_MUTATION_KINDS,
  type DeviceBaseline,
  type DeviceMutationEntry,
  type DeviceMutationInput,
  type DeviceStateObservation,
  type MutationValue,
} from "./types";

export const REQUIRED_BASELINE_KINDS = DEVICE_MUTATION_KINDS;

export interface BaselineChange {
  kind: string;
  key: string;
  priorValue: MutationValue;
  currentValue: MutationValue;
  journaled: boolean;
}

export interface BaselineDiff {
  changes: readonly BaselineChange[];
  dirty: readonly string[];
}

function observationChange(
  before: DeviceStateObservation | undefined,
  after: DeviceStateObservation | undefined,
  journaled: boolean,
): BaselineChange | null {
  const observation = before ?? after;
  const absent: MutationValue = { state: "absent" };
  const priorValue = before?.value ?? absent;
  const currentValue = after?.value ?? absent;
  return !observation || isDeepStrictEqual(priorValue, currentValue)
    ? null
    : { kind: observation.kind, key: observation.key, priorValue, currentValue, journaled };
}

function observationKey(observation: Pick<DeviceStateObservation, "kind" | "key">): string {
  return JSON.stringify([observation.kind, observation.key]);
}

function snapshotProblems(
  snapshot: DeviceBaseline,
  label: string,
  requiredKinds: readonly string[],
): string[] {
  const knownKinds = new Set<string>(DEVICE_MUTATION_KINDS);
  const keys = snapshot.observations.map(observationKey);
  return [
    ...requiredKinds
      .filter((kind) => !snapshot.completeKinds.includes(kind))
      .map((kind) => `${label}: incomplete ${kind} inventory`),
    ...snapshot.unobservable.map((kind) => `${label}: unobservable ${kind}`),
    ...snapshot.observations
      .filter((observation) => observation.value.state === "unobservable")
      .map((observation) => `${label}: unobservable ${observation.kind}:${observation.key}`),
    ...snapshot.completeKinds
      .filter((kind) => !knownKinds.has(kind))
      .map((kind) => `${label}: unknown inventory ${kind}`),
    ...snapshot.observations
      .filter((observation) => !snapshot.completeKinds.includes(observation.kind))
      .map((observation) => `${label}: incomplete ${observation.kind} inventory`),
    ...(keys.length === new Set(keys).size ? [] : [`${label}: duplicate observations`]),
  ];
}

export function diffDeviceBaseline(
  baseline: DeviceBaseline,
  current: DeviceBaseline,
  entries: readonly DeviceMutationEntry[] = [],
): BaselineDiff {
  const prior = new Map(
    baseline.observations.map((observation) => [observationKey(observation), observation]),
  );
  const after = new Map(
    current.observations.map((observation) => [observationKey(observation), observation]),
  );
  const journaled = new Set(entries.map(observationKey));
  const requiredKinds = [
    ...new Set([
      ...REQUIRED_BASELINE_KINDS,
      ...baseline.completeKinds,
      ...current.completeKinds,
      ...entries.map((entry) => entry.kind),
    ]),
  ];
  const changes = [...new Set([...prior.keys(), ...after.keys()])]
    .map((key) => observationChange(prior.get(key), after.get(key), journaled.has(key)))
    .filter((change) => change !== null);
  return {
    changes,
    dirty: [
      ...snapshotProblems(baseline, "baseline", requiredKinds),
      ...snapshotProblems(current, "current", requiredKinds),
    ],
  };
}

export function genericBaselineRevert(change: BaselineChange): DeviceMutationInput | null {
  const addedApp = change.kind === "installed-app" && change.priorValue.state === "absent";
  const emptyClipboard =
    change.kind === "clipboard" &&
    (change.priorValue.state === "absent" ||
      (change.priorValue.state === "present" &&
        (change.priorValue.value === "" || change.priorValue.value === null)));
  return addedApp || emptyClipboard
    ? {
        kind: change.kind,
        key: change.key,
        priorValue: change.priorValue,
        toolName: "baseline-diff",
      }
    : null;
}
