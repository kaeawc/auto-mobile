import { ActionableError } from "./ActionableError";
import type { FixtureInvalidationReason } from "./FixtureIdentity";

/** Typed response codes for a refused snapshot-fixture capture or reload (#14065). */
export type SnapshotFixtureRefusalCode =
  | "fixture_requires_vm_snapshot"
  | "snapshot_not_a_fixture"
  | "fixture_invalidated";

/**
 * A `deviceSnapshot` fixture call that cannot run as asked. Not retryable as-is: a fixture needs an
 * emulator VM snapshot, and an invalidated fixture stays invalid until it is captured again.
 */
export class SnapshotFixtureRefusedError extends ActionableError {
  readonly retryable = false;

  constructor(
    readonly code: SnapshotFixtureRefusalCode,
    readonly snapshotName: string,
    message: string,
    readonly reasons: readonly FixtureInvalidationReason[] = [],
  ) {
    super(message);
    this.name = "SnapshotFixtureRefusedError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      snapshotName: this.snapshotName,
      retryable: this.retryable,
      ...(this.reasons.length > 0 ? { reasons: [...this.reasons] } : {}),
    };
  }
}
