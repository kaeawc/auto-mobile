import type { BrokerExecutionReleaseOptions } from "./executionReleaseContracts";
import type { BindingProcessIdentity } from "../registry/bindingRegistry";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { BindingAssignmentRecord } from "../registry/bindingRegistry";
import { journalOwnersEqual } from "../registry/bindingRegistry";
import {
  type ManagedExecutionBindingFailure,
  type ManagedExecutionBindingRegistry,
  type MarkAttempt,
  type MarkedBinding,
  bindingKeyOf,
} from "./executionReleaseContracts";
interface ExecutionReleaseMarksContext {
  warn: (message: string, error?: unknown) => void;
  settlerIdentity: () => BindingProcessIdentity;
  options: BrokerExecutionReleaseOptions;
}

/**
 * Mark one binding `settling`. Resolves to the fence, or to null when the registry refused the
 * mark (the binding moved on; reported in `failures`). Throws when the mark is still owed.
 *
 * The mark is idempotent across attempts. A registry call can reject after its transaction
 * committed, so a throw is followed by a re-read: a binding that is durably `settling` under this
 * daemon at the binding this mark enters is marked, and gets its watcher like any other. The
 * same re-read follows a refusal, which is what a retry of such a mark comes to once the first
 * attempt's re-read failed too (the fence already moved the generation on).
 */
export async function markBinding(
  context: ExecutionReleaseMarksContext,
  registry: ManagedExecutionBindingRegistry,
  assignment: BindingAssignmentRecord,
  failures: ManagedExecutionBindingFailure[],
): Promise<MarkedBinding | null> {
  let attempt: MarkAttempt;
  try {
    attempt = await markBindingOnce(context, registry, assignment);
  } catch (error) {
    const landed = await findOwnMark(context, registry, assignment);
    if (landed === null) {
      throw error;
    }
    const key = bindingKeyOf(assignment);
    context.warn(
      `[BrokerExecutionRelease] Marking binding ${key.scopeKey}/${key.bindingIndex} settling failed ` +
        `after the mark was written; going on from the written mark: ${errorMessage(error)}`,
      error,
    );
    return landed;
  }
  if (!("refused" in attempt)) {
    return attempt;
  }
  const landed = await findOwnMark(context, registry, assignment);
  if (landed === null) {
    failures.push({
      ...bindingKeyOf(assignment),
      error: `could not mark settling: ${attempt.refused}`,
    });
  }
  return landed;
}

/** One attempt at the mark: through a release journal entry, else directly. */
export async function markBindingOnce(
  context: ExecutionReleaseMarksContext,
  registry: ManagedExecutionBindingRegistry,
  assignment: BindingAssignmentRecord,
): Promise<MarkAttempt> {
  const journaled = await markJournaled(context, registry, assignment);
  if (journaled !== "unjournaled") {
    return journaled;
  }
  const key = bindingKeyOf(assignment);
  const updated = await registry.updateBindingState(
    key,
    { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
    "settling",
    { settler: context.settlerIdentity() },
  );
  if (updated.kind !== "updated") {
    return { refused: updated.kind };
  }
  // Entering the fence bumped the generation; the watcher restores under the new one.
  return {
    key,
    execOwner: updated.assignment.execOwner,
    generation: updated.assignment.generation,
    stableDeviceId: updated.assignment.stableDeviceId,
  };
}

/**
 * This drain's own `settling` mark of `assignment`, read back from the registry: the binding is
 * `settling` under this daemon, on the same device, one generation past the binding the mark
 * was made from (entering the fence advances it by one). A `settling` binding accepts no claim and
 * no other fence, so nothing else produces that state from that binding. Null when the mark is
 * not there. May throw (registry).
 */
export async function findOwnMark(
  context: Pick<ExecutionReleaseMarksContext, "settlerIdentity" | "options">,
  registry: ManagedExecutionBindingRegistry,
  assignment: BindingAssignmentRecord,
): Promise<MarkedBinding | null> {
  const key = bindingKeyOf(assignment);
  const self = context.settlerIdentity();
  const current = await registry.getAssignment(key);
  if (
    current === null ||
    current.state !== "settling" ||
    current.settler === null ||
    !journalOwnersEqual(current.settler, self) ||
    current.stableDeviceId !== assignment.stableDeviceId ||
    current.generation !== assignment.generation + 1
  ) {
    return null;
  }
  const marked: MarkedBinding = {
    key,
    execOwner: current.execOwner,
    generation: current.generation,
    stableDeviceId: current.stableDeviceId,
  };
  const journal = context.options.journal;
  if (!journal) {
    return marked;
  }
  const entry = (await registry.listOpenBindingJournal(key)).find(
    (open) => open.kind === "release" && journalOwnersEqual(open.owner, self),
  );
  if (!entry) {
    return marked;
  }
  journal.inFlight.add(entry.id);
  return { ...marked, journalEntryId: entry.id };
}

/**
 * Mark one binding `settling` through a release journal entry, in one transaction. Returns
 * `unjournaled` when journaling is off or the binding already has an open entry (which governs it),
 * so the caller marks the binding directly.
 */
export async function markJournaled(
  context: Pick<ExecutionReleaseMarksContext, "options" | "settlerIdentity">,
  registry: ManagedExecutionBindingRegistry,
  assignment: BindingAssignmentRecord,
): Promise<MarkAttempt | "unjournaled"> {
  const journal = context.options.journal;
  if (!journal) {
    return "unjournaled";
  }
  const key = bindingKeyOf(assignment);
  const settler = context.settlerIdentity();
  const opened = await registry.openBindingJournal(key, {
    kind: "release",
    phase: "intent",
    owner: settler,
    target: {
      oldStableId: assignment.stableDeviceId,
      oldName: assignment.deviceName,
      newName: null,
      newStableId: null,
      requestedSpec: assignment.requestedSpec,
      resolvedSpec: assignment.resolvedSpec,
      specFingerprint: assignment.specFingerprint,
    },
    assignment: {
      kind: "state",
      expected: { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
      state: "settling",
      options: { settler },
    },
  });
  if (opened.kind === "opened") {
    journal.inFlight.add(opened.entry.id);
    // Entering the fence bumped the generation; the watcher restores under the new one.
    return {
      key,
      execOwner: opened.assignment.execOwner,
      generation: opened.assignment.generation,
      stableDeviceId: opened.assignment.stableDeviceId,
      journalEntryId: opened.entry.id,
    };
  }
  if (opened.kind === "journal_open") {
    return "unjournaled";
  }
  return { refused: opened.kind };
}
