import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Kysely } from "kysely";
import {
  ProvisionDeviceOperationConflictError,
  ProvisionDeviceOperationRepository,
  type ProvisionDeviceOperationBeginResult,
} from "../../src/db/provisionDeviceOperationRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";

// Property-based, model-based test of the operation-row state machine. See
// Backoff.property.test.ts for the pinned-seed rationale.
//
// The repository is a compare-and-set fenced by an ATTEMPT token; the reference
// model below re-implements the documented transition table, and each generated
// command is applied to BOTH the real repository (over an in-memory SQLite DB)
// and the model, asserting they stay in lock-step. Migrations are expensive, so
// one database is shared across runs and every run uses a unique operationId to
// stay isolated; a far-future expiry with now=0 keeps the expiry sweep inert.
const RUN_OPTIONS = { seed: 0x50_64_4f_70, numRuns: 150 } as const;
const NOW_MS = 0;
const FAR_FUTURE_EXPIRY_MS = 1_000_000;

type ModelStatus = "absent" | "running" | "succeeded" | "replaying" | "failed";

interface ModelRow {
  status: ModelStatus;
  attemptId: string;
  fingerprint: string;
  result: Record<string, unknown> | undefined;
  creationStarted: boolean;
}

/** The reference model: the transition table the repository must implement. */
class OperationModel {
  private row: ModelRow = {
    status: "absent",
    attemptId: "",
    fingerprint: "",
    result: undefined,
    creationStarted: false,
  };

  begin(
    fingerprint: string,
    attemptId: string,
  ): ProvisionDeviceOperationBeginResult | { conflict: true } {
    if (this.row.status === "absent") {
      this.row = {
        status: "running",
        attemptId,
        fingerprint,
        result: undefined,
        creationStarted: false,
      };
      return { started: true, reconcileExistingConfiguration: false };
    }
    if (this.row.fingerprint !== fingerprint) {
      return { conflict: true };
    }
    if (this.row.status === "running" || this.row.status === "replaying") {
      return { started: false, inProgress: true };
    }
    if (this.row.status === "succeeded" && this.row.result) {
      const reconcile = this.row.creationStarted;
      this.row = { ...this.row, status: "replaying", attemptId };
      return { started: false, result: this.row.result, reconcileExistingConfiguration: reconcile };
    }
    // A terminally failed row is re-admitted with a fresh fence.
    const reconcile = this.row.creationStarted;
    this.row = { ...this.row, status: "running", attemptId };
    return { started: true, reconcileExistingConfiguration: reconcile };
  }

  markDeviceCreationStarted(attemptId: string): boolean {
    if (this.row.status === "absent" || this.row.attemptId !== attemptId) {
      return false;
    }
    this.row.creationStarted = true;
    return true;
  }

  complete(attemptId: string, result: Record<string, unknown>): boolean {
    if (this.row.status === "absent" || this.row.attemptId !== attemptId) {
      return false;
    }
    this.row = { ...this.row, status: "succeeded", result };
    return true;
  }

  fail(attemptId: string, clearCreationStarted: boolean): boolean {
    if (this.row.status === "absent" || this.row.attemptId !== attemptId) {
      return false;
    }
    // A failed REPLAY reverts to succeeded, preserving the completed result.
    this.row.status = this.row.status === "replaying" ? "succeeded" : "failed";
    if (clearCreationStarted) {
      this.row.creationStarted = false;
    }
    return true;
  }
}

type Command =
  | { kind: "begin"; fingerprint: string; attemptId: string }
  | { kind: "mark"; attemptId: string }
  | { kind: "complete"; attemptId: string; resultTag: number }
  | { kind: "fail"; attemptId: string; clear: boolean };

const attemptPool = fc.constantFrom("t0", "t1", "t2", "t3");
const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant("begin" as const),
    fingerprint: fc.constantFrom("fp-A", "fp-B"),
    attemptId: attemptPool,
  }),
  fc.record({ kind: fc.constant("mark" as const), attemptId: attemptPool }),
  fc.record({
    kind: fc.constant("complete" as const),
    attemptId: attemptPool,
    resultTag: fc.integer({ min: 0, max: 5 }),
  }),
  fc.record({ kind: fc.constant("fail" as const), attemptId: attemptPool, clear: fc.boolean() }),
);

describe("ProvisionDeviceOperationRepository (property-based)", () => {
  let db: Kysely<Database>;
  let operationCounter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  test("mirrors the fenced state machine for arbitrary command sequences", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 12 }), async (commands) => {
        const repository = new ProvisionDeviceOperationRepository(db);
        const model = new OperationModel();
        const operationId = `prop-op-${operationCounter++}`;

        for (const cmd of commands) {
          switch (cmd.kind) {
            case "begin": {
              const expected = model.begin(cmd.fingerprint, cmd.attemptId);
              if ("conflict" in expected) {
                await expect(
                  repository.begin(
                    operationId,
                    cmd.fingerprint,
                    cmd.attemptId,
                    NOW_MS,
                    FAR_FUTURE_EXPIRY_MS,
                  ),
                ).rejects.toBeInstanceOf(ProvisionDeviceOperationConflictError);
              } else {
                const actual = await repository.begin(
                  operationId,
                  cmd.fingerprint,
                  cmd.attemptId,
                  NOW_MS,
                  FAR_FUTURE_EXPIRY_MS,
                );
                expect(actual).toEqual(expected);
              }
              break;
            }
            case "mark":
              expect(await repository.markDeviceCreationStarted(operationId, cmd.attemptId)).toBe(
                model.markDeviceCreationStarted(cmd.attemptId),
              );
              break;
            case "complete": {
              const result = { deviceId: `dev-${cmd.resultTag}` };
              expect(await repository.complete(operationId, cmd.attemptId, result)).toBe(
                model.complete(cmd.attemptId, result),
              );
              break;
            }
            case "fail":
              expect(
                await repository.fail(operationId, cmd.attemptId, "code", "message", {
                  clearCreationStarted: cmd.clear,
                }),
              ).toBe(model.fail(cmd.attemptId, cmd.clear));
              break;
          }
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("only one attempt at a time can mutate a row (fencing)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom("a1", "a2", "a3"), { minLength: 2, maxLength: 3 }),
        async (attempts) => {
          const repository = new ProvisionDeviceOperationRepository(db);
          const operationId = `prop-fence-${operationCounter++}`;
          const [owner, ...others] = attempts;

          expect(
            await repository.begin(operationId, "fp", owner!, NOW_MS, FAR_FUTURE_EXPIRY_MS),
          ).toEqual({ started: true, reconcileExistingConfiguration: false });

          // Every non-owner attempt is fenced out of all three mutations.
          for (const stale of others) {
            expect(await repository.markDeviceCreationStarted(operationId, stale)).toBe(false);
            expect(await repository.complete(operationId, stale, { deviceId: "x" })).toBe(false);
            expect(await repository.fail(operationId, stale, "code", "message")).toBe(false);
          }
          // The owner still holds the fence and can complete the operation.
          expect(await repository.complete(operationId, owner!, { deviceId: "owned" })).toBe(true);
        },
      ),
      RUN_OPTIONS,
    );
  });
});
