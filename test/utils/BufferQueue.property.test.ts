import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { BufferQueue } from "../../src/utils/BufferQueue";

// Property-based testing. See Backoff.property.test.ts for the rationale behind
// the pinned seed.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

type Op =
  | { kind: "append"; bytes: number[] }
  | { kind: "peek"; length: number }
  | { kind: "take"; length: number }
  | { kind: "discard"; length: number };

const smallByteArray = fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 6 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("append" as const), bytes: smallByteArray }),
  fc.record({ kind: fc.constant("peek" as const), length: fc.nat({ max: 8 }) }),
  fc.record({ kind: fc.constant("take" as const), length: fc.nat({ max: 8 }) }),
  fc.record({ kind: fc.constant("discard" as const), length: fc.nat({ max: 8 }) }),
);

describe("BufferQueue (property-based)", () => {
  test("append/peek/take/discard match a flat-buffer reference model", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 0, maxLength: 60 }), (ops) => {
        const queue = new BufferQueue();
        let model: number[] = [];
        for (const op of ops) {
          switch (op.kind) {
            case "append":
              queue.append(Buffer.from(op.bytes));
              model = model.concat(op.bytes);
              break;
            case "peek":
              if (op.length > model.length) {
                expect(() => queue.peek(op.length)).toThrow(RangeError);
              } else {
                expect([...queue.peek(op.length)]).toEqual(model.slice(0, op.length));
              }
              break;
            case "take":
              if (op.length > model.length) {
                expect(() => queue.takeDetached(op.length)).toThrow(RangeError);
              } else {
                expect([...queue.takeDetached(op.length)]).toEqual(model.slice(0, op.length));
                model = model.slice(op.length);
              }
              break;
            case "discard":
              if (op.length > model.length) {
                expect(() => queue.discard(op.length)).toThrow(RangeError);
              } else {
                queue.discard(op.length);
                model = model.slice(op.length);
              }
              break;
          }
          expect(queue.length).toBe(model.length);
          expect([...queue.toBuffer()]).toEqual(model);
        }
      }),
      RUN_OPTIONS,
    );
  });
});
