import { expect, test } from "bun:test";
import { MovedSwipeTally } from "../../../../src/features/action/swipeon/movedSwipeTally";

test("fresh moves count at once", () => {
  const tally = new MovedSwipeTally();
  tally.reset("a");
  tally.recordMove(true, true);
  tally.confirm("b", true);
  expect(tally.count).toBe(1);
});

test("stale moves count once a fresh frame shows different content", () => {
  const tally = new MovedSwipeTally();
  tally.reset("a");
  tally.recordMove(false, true);
  tally.confirm("b", false);
  tally.recordMove(false, true);
  tally.confirm("c", false);
  expect(tally.count).toBe(0);
  tally.confirm("c", true);
  expect(tally.count).toBe(2);
});

test("stale moves are discarded when the fresh frame matches the confirmed content", () => {
  const tally = new MovedSwipeTally();
  tally.reset("a");
  tally.recordMove(false, true);
  tally.confirm("a", true);
  tally.confirm("b", true);
  expect(tally.count).toBe(0);
});

test("a stale move that is not held never counts", () => {
  const tally = new MovedSwipeTally();
  tally.reset("a");
  tally.recordMove(false, false);
  tally.confirm("b", true);
  expect(tally.count).toBe(0);
});
