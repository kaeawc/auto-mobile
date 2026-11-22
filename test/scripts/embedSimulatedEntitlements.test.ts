import { describe, expect, test } from "bun:test";
import {
  embedSimulatedEntitlements,
  SIMULATED_ENTITLEMENTS_PLIST,
} from "../../scripts/ios/embedSimulatedEntitlements";

const SLICE_SIZE = 0x4000;
const TEXT_CMD_SIZE = 72 + 80;
const SECTION_FILE_OFFSET = 0x400;
const TEXT_SECTION_SIZE = 0x100;

function name16(value: string): Buffer {
  const out = Buffer.alloc(16);
  out.write(value, "latin1");
  return out;
}

/** A minimal thin arm64 image: __PAGEZERO, a __TEXT with one `__text` section, and slack after it. */
function thinImage(): Buffer {
  const image = Buffer.alloc(SLICE_SIZE);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeInt32LE(0x0100000c, 4);
  image.writeUInt32LE(2, 12);
  image.writeUInt32LE(2, 16);
  image.writeUInt32LE(72 + TEXT_CMD_SIZE, 20);

  let at = 32;
  image.writeUInt32LE(0x19, at);
  image.writeUInt32LE(72, at + 4);
  name16("__PAGEZERO").copy(image, at + 8);

  at += 72;
  image.writeUInt32LE(0x19, at);
  image.writeUInt32LE(TEXT_CMD_SIZE, at + 4);
  name16("__TEXT").copy(image, at + 8);
  image.writeBigUInt64LE(0x100000000n, at + 24);
  image.writeBigUInt64LE(BigInt(SLICE_SIZE), at + 32);
  image.writeBigUInt64LE(0n, at + 40);
  image.writeBigUInt64LE(BigInt(SLICE_SIZE), at + 48);
  image.writeUInt32LE(1, at + 64);
  const section = at + 72;
  name16("__text").copy(image, section);
  name16("__TEXT").copy(image, section + 16);
  image.writeBigUInt64LE(0x100000000n + BigInt(SECTION_FILE_OFFSET), section + 32);
  image.writeBigUInt64LE(BigInt(TEXT_SECTION_SIZE), section + 40);
  image.writeUInt32LE(SECTION_FILE_OFFSET, section + 48);
  image.fill(0x90, SECTION_FILE_OFFSET, SECTION_FILE_OFFSET + TEXT_SECTION_SIZE);
  return image;
}

function sectionNames(slice: Buffer): string[] {
  const text = 32 + 72;
  const count = slice.readUInt32LE(text + 64);
  return Array.from({ length: count }, (_, i) => {
    const at = text + 72 + i * 80;
    return slice.toString("latin1", at, at + 16).replace(/\0+$/, "");
  });
}

describe("embedSimulatedEntitlements", () => {
  test("adds a __TEXT,__entitlements section holding the plist", () => {
    const { image, changed } = embedSimulatedEntitlements(thinImage());

    expect(changed).toBe(true);
    expect(sectionNames(image)).toEqual(["__text", "__entitlements"]);
    expect(image.readUInt32LE(20)).toBe(72 + TEXT_CMD_SIZE + 80);
    expect(image.readUInt32LE(32 + 72 + 4)).toBe(TEXT_CMD_SIZE + 80);
    const sectionHeader = 32 + 72 + 72 + 80;
    const dataOffset = image.readUInt32LE(sectionHeader - 80 + 48 + 80);
    expect(dataOffset).toBe(SECTION_FILE_OFFSET + TEXT_SECTION_SIZE);
    const size = Number(image.readBigUInt64LE(sectionHeader - 80 + 40 + 80));
    expect(image.toString("utf8", dataOffset, dataOffset + size)).toBe(
      SIMULATED_ENTITLEMENTS_PLIST,
    );
    expect(image.readBigUInt64LE(sectionHeader - 80 + 32 + 80)).toBe(
      0x100000000n + BigInt(dataOffset),
    );
  });

  test("leaves the executable code untouched", () => {
    const original = thinImage();
    const { image } = embedSimulatedEntitlements(original);

    expect(
      image
        .subarray(SECTION_FILE_OFFSET, SECTION_FILE_OFFSET + TEXT_SECTION_SIZE)
        .equals(original.subarray(SECTION_FILE_OFFSET, SECTION_FILE_OFFSET + TEXT_SECTION_SIZE)),
    ).toBe(true);
  });

  test("is idempotent", () => {
    const once = embedSimulatedEntitlements(thinImage()).image;
    const twice = embedSimulatedEntitlements(once);

    expect(twice.changed).toBe(false);
    expect(twice.image.equals(once)).toBe(true);
  });

  test("patches every slice of a fat image", () => {
    const fat = Buffer.alloc(0x1000 + SLICE_SIZE * 2);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    [0x1000, 0x1000 + SLICE_SIZE].forEach((start, i) => {
      const entry = 8 + i * 20;
      fat.writeUInt32BE(start, entry + 8);
      fat.writeUInt32BE(SLICE_SIZE, entry + 12);
      thinImage().copy(fat, start);
    });

    const { image, changed } = embedSimulatedEntitlements(fat);

    expect(changed).toBe(true);
    expect(sectionNames(image.subarray(0x1000, 0x1000 + SLICE_SIZE))).toEqual([
      "__text",
      "__entitlements",
    ]);
    expect(sectionNames(image.subarray(0x1000 + SLICE_SIZE))).toEqual(["__text", "__entitlements"]);
  });

  test("refuses an image with no header room", () => {
    const cramped = thinImage();
    cramped.writeUInt32LE(32 + 72 + TEXT_CMD_SIZE + 8, 32 + 72 + 72 + 48);

    expect(() => embedSimulatedEntitlements(cramped)).toThrow("No room in the Mach-O header");
  });

  test("rejects a non Mach-O image", () => {
    expect(() => embedSimulatedEntitlements(Buffer.alloc(64))).toThrow("Unsupported Mach-O");
  });
});
