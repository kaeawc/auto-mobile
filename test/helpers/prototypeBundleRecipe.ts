import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import type { BundleLimits } from "../../src/features/prototype/bundle/bundleLimits";
import type { BundleErrorCode } from "../../src/features/prototype/bundle/bundleErrors";

export interface RecipeEntry {
  name: string;
  text?: string;
  base64?: string;
  repeat?: { byte: number; count: number };
  rawBase64?: string;
  method?: number;
  flags?: number;
  attrs?: number;
  compressedSize?: number;
  expandedSize?: number;
  crc?: number;
  extraBase64?: string;
}
export interface RecipePatch {
  region: "local" | "central" | "eocd" | "absolute";
  index?: number;
  offset: number;
  type: "u16" | "u32" | "base64";
  value: number | string;
}
export interface BundleRecipe {
  description: string;
  base?: "minimal" | "assets_fonts";
  spec?: unknown;
  manifest?: Record<string, unknown>;
  omit?: string[];
  overrides?: RecipeEntry[];
  entries?: RecipeEntry[];
  patches?: RecipePatch[];
  trailingBase64?: string;
  truncate?: number;
  limits?: Partial<BundleLimits>;
  expected: "accept" | { code: BundleErrorCode; entry?: string };
}
export const RECIPE_MINIMAL_SPEC = {
  id: "minimal",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
};
const image = Buffer.from([1, 2, 3]);
const font = Buffer.from([0, 1, 0, 0]);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const RECIPE_IMAGE_PATH = `assets/${hash(image)}.png`;
export const RECIPE_FONT_PATH = `fonts/${hash(font)}.ttf`;
export function recipeName(name: string): string {
  return name === "$image" ? RECIPE_IMAGE_PATH : name === "$font" ? RECIPE_FONT_PATH : name;
}
function baseEntries(recipe: BundleRecipe): RecipeEntry[] {
  if (!recipe.base) {
    return [];
  }
  const withAssets = recipe.base === "assets_fonts";
  const spec =
    recipe.spec ??
    (withAssets
      ? {
          ...RECIPE_MINIMAL_SPEC,
          root: {
            type: "column",
            children: [
              { type: "image", asset: "image" },
              { type: "text", text: "Font", style: { fontFamily: { asset: "font" } } },
            ],
          },
        }
      : RECIPE_MINIMAL_SPEC);
  const specJson = JSON.stringify(spec);
  const manifest = {
    bundleFormatVersion: 1,
    specSha256: hash(Buffer.from(specJson)),
    assets: withAssets
      ? [{ id: "image", file: RECIPE_IMAGE_PATH, sha256: hash(image), mediaType: "image/png" }]
      : [],
    fonts: withAssets
      ? [{ id: "font", file: RECIPE_FONT_PATH, sha256: hash(font), mediaType: "font/ttf" }]
      : [],
    requires: [],
    ...recipe.manifest,
  };
  return [
    { name: "bundle.json", text: JSON.stringify(manifest) },
    { name: "spec.json", text: specJson },
    ...(withAssets
      ? [
          { name: RECIPE_IMAGE_PATH, base64: image.toString("base64") },
          { name: RECIPE_FONT_PATH, base64: font.toString("base64") },
        ]
      : []),
  ];
}
function entryBytes(entry: RecipeEntry): Buffer {
  if (entry.repeat) {
    return Buffer.alloc(entry.repeat.count, entry.repeat.byte);
  }
  if (entry.base64 !== undefined) {
    return Buffer.from(entry.base64, "base64");
  }
  return Buffer.from(entry.text ?? "");
}
interface MaterializedEntry {
  local: Buffer;
  central: Buffer;
}
function materializeEntry(entry: RecipeEntry, offset: number): MaterializedEntry {
  const data = entryBytes(entry);
  const method = entry.method ?? 0;
  const compressed =
    entry.rawBase64 !== undefined
      ? Buffer.from(entry.rawBase64, "base64")
      : method === 8
        ? deflateRawSync(data, { level: 6 })
        : data;
  const name = Buffer.from(recipeName(entry.name));
  const extra = Buffer.from(entry.extraBase64 ?? "", "base64");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(entry.flags ?? 0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(entry.crc ?? crc32(data), 14);
  local.writeUInt32LE(entry.compressedSize ?? compressed.length, 18);
  local.writeUInt32LE(entry.expandedSize ?? data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(extra.length, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(3 * 256 + 20, 4);
  central.writeUInt16LE(20, 6);
  local.copy(central, 8, 6, 26);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE(entry.attrs ?? 0, 38);
  central.writeUInt32LE(offset, 42);
  return {
    local: Buffer.concat([local, name, extra, compressed]),
    central: Buffer.concat([central, name, extra]),
  };
}
function applyPatch(
  bytes: Buffer,
  patch: RecipePatch,
  regions: Record<RecipePatch["region"], number[]>,
): void {
  const base = regions[patch.region][patch.index ?? 0];
  if (base === undefined) {
    throw new Error("Recipe patch references a missing region");
  }
  const offset = base + patch.offset;
  if (patch.type === "u16" && typeof patch.value === "number") {
    bytes.writeUInt16LE(patch.value, offset);
  } else if (patch.type === "u32" && typeof patch.value === "number") {
    bytes.writeUInt32LE(patch.value, offset);
  } else if (patch.type === "base64" && typeof patch.value === "string") {
    Buffer.from(patch.value, "base64").copy(bytes, offset);
  } else {
    throw new Error("Invalid recipe patch value");
  }
}
/** Independent ZIP32 writer: intentionally does not call the production writer/parser. */
export function materializeBundleRecipe(recipe: BundleRecipe): Uint8Array {
  const initial = baseEntries(recipe).filter((entry) => !recipe.omit?.includes(entry.name));
  const entries = initial.map((entry) => ({
    ...entry,
    ...recipe.overrides?.find((item) => recipeName(item.name) === entry.name),
  }));
  entries.push(...(recipe.entries ?? []));
  const regions: Record<RecipePatch["region"], number[]> = {
    local: [],
    central: [],
    eocd: [],
    absolute: [0],
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let size = 0;
  for (const entry of entries) {
    regions.local.push(size);
    const built = materializeEntry(entry, size);
    locals.push(built.local);
    centrals.push(built.central);
    size += built.local.length;
  }
  const directoryOffset = size;
  for (const central of centrals) {
    regions.central.push(size);
    size += central.length;
  }
  regions.eocd.push(size);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size - directoryOffset, 12);
  end.writeUInt32LE(directoryOffset, 16);
  const bytes = Buffer.concat([
    ...locals,
    ...centrals,
    end,
    Buffer.from(recipe.trailingBase64 ?? "", "base64"),
  ]);
  for (const patch of recipe.patches ?? []) {
    applyPatch(bytes, patch, regions);
  }
  return recipe.truncate ? bytes.subarray(0, bytes.length - recipe.truncate) : bytes;
}
