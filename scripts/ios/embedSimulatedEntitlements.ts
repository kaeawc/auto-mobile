#!/usr/bin/env bun
/**
 * Embed simulated entitlements into the XCUITest runner executable.
 *
 * Xcode links `__TEXT,__entitlements` into simulator apps built with "Sign to Run Locally"; the
 * XCTRunner template that Xcode copies into `CtrlProxyUITests-Runner.app` is prebuilt and has no
 * such section, so storekitd rejects every runner request with "<runner> is not installed for
 * development" on iOS 26 (#18644). Signing the entitlement into the code signature instead makes
 * the kernel kill the process ("Taskgated Invalid Signature"), so the section is the only route.
 *
 * Usage: bun scripts/ios/embedSimulatedEntitlements.ts <runner-executable>
 * The caller re-signs the runner bundle ad hoc afterwards.
 */
import { readFileSync, writeFileSync } from "node:fs";

export const SIMULATED_ENTITLEMENTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>get-task-allow</key>
\t<true/>
</dict>
</plist>
`;

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_SEGMENT_64 = 0x19;
const HEADER_SIZE = 32;
const SECTION_SIZE = 80;
const SEGMENT_HEADER_SIZE = 72;
const SEGMENT_NAME_OFFSET = 8;
const NSECTS_OFFSET = 64;
const SECTION_NAME = "__entitlements";
const SEGMENT_NAME = "__TEXT";

function fixedName(value: string): Buffer {
  const out = Buffer.alloc(16);
  out.write(value, "latin1");
  return out;
}

function readName(buf: Buffer, offset: number): string {
  const end = buf.indexOf(0, offset);
  return buf.toString("latin1", offset, Math.min(end < 0 ? offset + 16 : end, offset + 16));
}

/** Add `__TEXT,__entitlements` to one thin little-endian 64-bit Mach-O slice, in place. */
function patchSlice(slice: Buffer, entitlements: Buffer): boolean {
  if (slice.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error("Unsupported Mach-O slice: expected a 64-bit little-endian image");
  }
  const ncmds = slice.readUInt32LE(16);
  const sizeofcmds = slice.readUInt32LE(20);
  const cmdsEnd = HEADER_SIZE + sizeofcmds;

  let textOffset = -1;
  let textCmdSize = 0;
  let offset = HEADER_SIZE;
  for (let i = 0; i < ncmds; i += 1) {
    const cmd = slice.readUInt32LE(offset);
    const cmdSize = slice.readUInt32LE(offset + 4);
    if (cmd === LC_SEGMENT_64 && readName(slice, offset + SEGMENT_NAME_OFFSET) === SEGMENT_NAME) {
      textOffset = offset;
      textCmdSize = cmdSize;
    }
    offset += cmdSize;
  }
  if (textOffset < 0) {
    throw new Error("Mach-O slice has no __TEXT segment");
  }

  const nsects = slice.readUInt32LE(textOffset + NSECTS_OFFSET);
  const firstSection = textOffset + SEGMENT_HEADER_SIZE;
  let dataOffset = 0;
  let dataAddr = 0n;
  let firstSectionFileOffset = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < nsects; i += 1) {
    const at = firstSection + i * SECTION_SIZE;
    if (readName(slice, at) === SECTION_NAME) {
      return false; // already embedded
    }
    const addr = slice.readBigUInt64LE(at + 32);
    const size = slice.readBigUInt64LE(at + 40);
    const fileOffset = slice.readUInt32LE(at + 48);
    firstSectionFileOffset = Math.min(firstSectionFileOffset, fileOffset);
    if (fileOffset + Number(size) > dataOffset) {
      dataOffset = fileOffset + Number(size);
      dataAddr = addr + size;
    }
  }

  const segmentFileSize = Number(slice.readBigUInt64LE(textOffset + 48));
  if (cmdsEnd + SECTION_SIZE > firstSectionFileOffset) {
    throw new Error("No room in the Mach-O header for another section");
  }
  if (dataOffset + entitlements.length > segmentFileSize) {
    throw new Error("No room in the __TEXT segment for the entitlements");
  }
  if (!slice.subarray(dataOffset, dataOffset + entitlements.length).every((b) => b === 0)) {
    throw new Error("The __TEXT segment slack is not empty");
  }

  const insertAt = textOffset + textCmdSize;
  slice.copy(slice, insertAt + SECTION_SIZE, insertAt, cmdsEnd);
  const header = Buffer.alloc(SECTION_SIZE);
  fixedName(SECTION_NAME).copy(header, 0);
  fixedName(SEGMENT_NAME).copy(header, 16);
  header.writeBigUInt64LE(dataAddr, 32);
  header.writeBigUInt64LE(BigInt(entitlements.length), 40);
  header.writeUInt32LE(dataOffset, 48);
  header.copy(slice, insertAt);
  slice.writeUInt32LE(textCmdSize + SECTION_SIZE, textOffset + 4);
  slice.writeUInt32LE(nsects + 1, textOffset + NSECTS_OFFSET);
  slice.writeUInt32LE(sizeofcmds + SECTION_SIZE, 20);
  entitlements.copy(slice, dataOffset);
  return true;
}

/**
 * Return a copy of a thin or fat Mach-O image with the entitlements section added to every
 * slice, and whether anything changed. Existing code signatures become stale: re-sign after.
 */
export function embedSimulatedEntitlements(
  image: Buffer,
  plist: string = SIMULATED_ENTITLEMENTS_PLIST,
): { image: Buffer; changed: boolean } {
  const out = Buffer.from(image);
  const entitlements = Buffer.from(plist, "utf8");
  if (out.readUInt32BE(0) === FAT_MAGIC) {
    const count = out.readUInt32BE(4);
    let changed = false;
    for (let i = 0; i < count; i += 1) {
      const entry = 8 + i * 20;
      const start = out.readUInt32BE(entry + 8);
      const size = out.readUInt32BE(entry + 12);
      changed = patchSlice(out.subarray(start, start + size), entitlements) || changed;
    }
    return { image: out, changed };
  }
  return { image: out, changed: patchSlice(out, entitlements) };
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write("Usage: embedSimulatedEntitlements.ts <runner-executable>\n");
    process.exit(1);
  }
  const { image, changed } = embedSimulatedEntitlements(readFileSync(target));
  if (changed) {
    writeFileSync(target, image);
  }
  process.stdout.write(
    changed ? `Embedded simulated entitlements in ${target}\n` : `Already embedded in ${target}\n`,
  );
}
