import { expect, test } from "bun:test";
import { SessionSlots } from "../../src/daemon/sessionSlots";

interface FakePayload {
  name: string;
}

const facets = [
  ["assignments", "getAssignment", "setAssignment", "deleteAssignment"],
  ["sharedAssignments", "getShared", "setShared", "deleteShared"],
  ["creations", "getCreation", "setCreation", "deleteCreation"],
  ["recoveries", "getRecovery", "setRecovery", "deleteRecovery"],
  ["releaseRequests", "getReleaseRequest", "setReleaseRequest", "deleteReleaseRequest"],
] as const;

test.each(facets)(
  "%s preserves values, insertion order and a live readonly view",
  (view, get, set, remove) => {
    const slots = new SessionSlots<
      FakePayload,
      FakePayload,
      FakePayload,
      FakePayload,
      FakePayload
    >();
    const borrowed: ReadonlyMap<string, FakePayload> = slots[view];
    const first = { name: "first" };
    const second = { name: "second" };
    const replacement = { name: "first" };
    expect(slots[get]("first")).toBeUndefined();
    expect(slots[remove]("first")).toBe(false);
    slots[set]("first", first);
    slots[set]("second", second);
    expect(slots[get]("first")).toBe(first);
    expect(borrowed.get("first")).toBe(first);
    expect(slots[view]).toBe(borrowed);
    slots[set]("first", replacement);
    expect(slots[get]("first")).toBe(replacement);
    expect(borrowed.get("first")).not.toBe(first);
    expect([...borrowed.keys()]).toEqual(["first", "second"]);
    expect(slots[remove]("first")).toBe(true);
    expect(slots[get]("first")).toBeUndefined();
    expect(borrowed.has("first")).toBe(false);
    slots[set]("first", first);
    expect([...borrowed]).toEqual([
      ["second", second],
      ["first", first],
    ]);
    expect(slots[remove]("second")).toBe(true);
    expect(slots[remove]("first")).toBe(true);
    expect(borrowed.size).toBe(0);
  },
);

test("assignment, creation and recovery membership follows their own facet", () => {
  const slots = new SessionSlots<object, object, object, object, object>();
  expect(slots.hasAssignment("id")).toBe(false);
  expect(slots.hasCreation("id")).toBe(false);
  expect(slots.hasRecovery("id")).toBe(false);
  slots.setAssignment("id", {});
  expect(slots.hasAssignment("id")).toBe(true);
  expect(slots.hasCreation("id")).toBe(false);
  expect(slots.hasRecovery("id")).toBe(false);
  slots.setCreation("id", {});
  slots.setRecovery("id", {});
  expect(slots.hasCreation("id")).toBe(true);
  expect(slots.hasRecovery("id")).toBe(true);
  slots.deleteAssignment("id");
  slots.deleteCreation("id");
  slots.deleteRecovery("id");
  expect(slots.hasAssignment("id")).toBe(false);
  expect(slots.hasCreation("id")).toBe(false);
  expect(slots.hasRecovery("id")).toBe(false);
});

test("assignment access returns the stored promise directly", () => {
  const slots = new SessionSlots<Promise<FakePayload>, object, object, object, object>();
  const assignment = Promise.withResolvers<FakePayload>();
  slots.setAssignment("id", assignment.promise);
  expect(slots.getAssignment("id")).toBe(assignment.promise);
  expect(slots.assignments.get("id")).toBe(assignment.promise);
  assignment.resolve({ name: "assigned" });
  expect(slots.getAssignment("id")).toBe(assignment.promise);
});

test("row claims use object identity and survive recovery deletion", () => {
  const slots = new SessionSlots<object, object, object, FakePayload, object>();
  const row = { name: "row" };
  const equalRow = { name: "row" };
  expect(slots.isRowClaimed(row)).toBe(false);
  slots.setRecovery("id", row);
  expect(slots.isRowClaimed(row)).toBe(false);
  slots.markRowClaimed(row);
  slots.markRowClaimed(row);
  expect(slots.isRowClaimed(row)).toBe(true);
  expect(slots.isRowClaimed(equalRow)).toBe(false);
  slots.deleteRecovery("id");
  expect(slots.isRowClaimed(row)).toBe(true);
});
