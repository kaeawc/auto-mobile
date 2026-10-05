import { describe, expect, test } from "bun:test";
import {
  OverlayEventBuffer,
  OVERLAY_EVENT_BUFFER_CAPACITY,
} from "../../../src/features/overlay/OverlayEventBuffer";
import { event } from "../../helpers/overlayTestEvent";

describe("OverlayEventBuffer", () => {
  test("consumes in sequence order and ignores late lower and replayed sequences", () => {
    const buffer = new OverlayEventBuffer();
    expect(buffer.push(event(1))).toBe(true);
    expect(buffer.push(event(3))).toBe(true);
    expect(buffer.push(event(2))).toBe(false);
    expect(buffer.take({})?.sequence).toBe(1);
    expect(buffer.take({})?.sequence).toBe(3);
    expect(buffer.push(event(3))).toBe(false);
    expect(buffer.push(event(1))).toBe(false);
    expect(buffer.status()).toEqual({ pendingCount: 0, lastSequence: 3, droppedCount: 0 });
  });
  test("filters and cursor preserve other pending events", () => {
    const buffer = new OverlayEventBuffer();
    buffer.push(event(1));
    buffer.push(event(2, "panel", "page_changed", "page"));
    buffer.push(event(3));
    expect(buffer.take({ eventName: "save", kind: "emit", afterSequence: 1 })?.sequence).toBe(3);
    expect(buffer.take({ kind: "dismissed" })).toBeUndefined();
    expect(buffer.take({})?.sequence).toBe(1);
    expect(buffer.take({})?.sequence).toBe(2);
  });
  test("overflow drops oldest and reports cumulative count", () => {
    const buffer = new OverlayEventBuffer();
    for (let sequence = 1; sequence <= OVERLAY_EVENT_BUFFER_CAPACITY + 2; sequence++) {
      buffer.push(event(sequence));
    }
    expect(buffer.status()).toEqual({
      pendingCount: OVERLAY_EVENT_BUFFER_CAPACITY,
      lastSequence: OVERLAY_EVENT_BUFFER_CAPACITY + 2,
      droppedCount: 2,
    });
    expect(buffer.take({})?.sequence).toBe(3);
  });
  test("startEpoch drops pending events and the high-water mark but keeps the dropped count", () => {
    const buffer = new OverlayEventBuffer();
    for (let sequence = 1; sequence <= OVERLAY_EVENT_BUFFER_CAPACITY + 1; sequence++) {
      buffer.push(event(sequence));
    }
    buffer.startEpoch();
    expect(buffer.status()).toEqual({ pendingCount: 0, droppedCount: 1 });
    expect(buffer.push(event(1))).toBe(true);
    expect(buffer.push(event(1))).toBe(false);
  });
});
