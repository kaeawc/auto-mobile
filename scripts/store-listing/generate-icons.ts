#!/usr/bin/env bun
/**
 * Renders every ProtoViewer icon raster from the single vector source (#14152).
 *
 *   bun scripts/store-listing/generate-icons.ts [--out <dir>] [--list]
 *
 * Output defaults to `build/store-listing/icons/` (git-ignored). The rasters are PNGs, which this
 * repository routes through Git LFS, so they are build artifacts and are not committed. `--list`
 * prints the target table without rendering. Rendering uses `sharp` (already a direct dependency;
 * libvips draws the SVG), loaded only when rendering so tests and `--list` stay dependency-free.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allIconTargets,
  iosContentsJson,
  ICON_SOURCE_DIR,
  IOS_DARK_BACKGROUND,
  type IconTarget,
} from "./iconTargets";

export interface IconSources {
  background: string;
  foreground: string;
}

/** Seam over the rasterizer so the target plan is testable without drawing pixels. */
export interface IconRenderer {
  render(target: IconTarget, sources: IconSources): Promise<Uint8Array>;
}

export interface RenderedIcon {
  path: string;
  bytes: Uint8Array;
}

export const DEFAULT_OUT_DIR = "build/store-listing/icons";

export function readIconSources(repoRoot: string): IconSources {
  return {
    background: readFileSync(join(repoRoot, ICON_SOURCE_DIR, "background.svg"), "utf8"),
    foreground: readFileSync(join(repoRoot, ICON_SOURCE_DIR, "foreground.svg"), "utf8"),
  };
}

/** Renders each target in table order; the order is stable so two runs write identical trees. */
export async function renderIcons(
  renderer: IconRenderer,
  sources: IconSources,
  targets: readonly IconTarget[] = allIconTargets(),
): Promise<RenderedIcon[]> {
  const rendered: RenderedIcon[] = [];
  for (const target of targets) {
    rendered.push({ path: target.path, bytes: await renderer.render(target, sources) });
  }
  rendered.push({
    path: "ios/AppIcon.appiconset/Contents.json",
    bytes: new TextEncoder().encode(iosContentsJson()),
  });
  return rendered;
}

/** Draws one target with sharp (libvips + librsvg). */
export async function createSharpRenderer(): Promise<IconRenderer> {
  const sharp = (await import("sharp")).default;
  const layer = (svg: string, size: number) =>
    sharp(Buffer.from(svg), { density: (72 * size) / 108 })
      .resize(size, size)
      .png();
  return {
    async render(target, sources) {
      const { size } = target;
      if (target.layer === "foreground") {
        return layer(sources.foreground, size).toBuffer();
      }
      if (target.layer === "background") {
        return layer(sources.background, size).toBuffer();
      }
      const foreground = await layer(sources.foreground, size).toBuffer();
      if (target.layer === "monochrome") {
        // Themed icons and the iOS tinted variant want a single-colour mask made from the
        // foreground's alpha: black on transparent for Android, white on black for iOS.
        const alpha = await sharp(foreground).extractChannel("alpha").raw().toBuffer();
        const shape = await sharp({
          create: {
            width: size,
            height: size,
            channels: 3,
            background: target.opaque ? "#ffffff" : "#000000",
          },
        })
          .joinChannel(alpha, { raw: { width: size, height: size, channels: 1 } })
          .png()
          .toBuffer();
        if (!target.opaque) {
          return shape;
        }
        return sharp({
          create: { width: size, height: size, channels: 3, background: "#000000" },
        })
          .composite([{ input: shape }])
          .removeAlpha()
          .png()
          .toBuffer();
      }
      const background = await layer(sources.background, size).toBuffer();
      const base =
        target.appearance === "dark"
          ? sharp({
              create: { width: size, height: size, channels: 3, background: IOS_DARK_BACKGROUND },
            }).png()
          : sharp(background);
      let composite = sharp(await base.png().toBuffer()).composite([{ input: foreground }]);
      if (target.roundedLegacy) {
        const radius = Math.round(size * 0.22);
        const mask = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`,
        );
        composite = sharp(await composite.png().toBuffer()).composite([
          { input: mask, blend: "dest-in" },
        ]);
      }
      if (target.opaque) {
        composite = composite.flatten({ background: "#000000" }).removeAlpha();
      }
      return composite.png().toBuffer();
    },
  };
}

export function parseArgs(argv: readonly string[]): { out?: string; list: boolean } {
  const out = argv.indexOf("--out");
  return {
    out: out >= 0 ? argv[out + 1] : undefined,
    list: argv.includes("--list"),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const args = parseArgs(argv);
  if (args.list) {
    allIconTargets().forEach((target) => {
      console.log(`${target.path}\t${target.size}x${target.size}\t${target.layer}`);
    });
    return 0;
  }
  const outDir = resolve(repoRoot, args.out ?? DEFAULT_OUT_DIR);
  const rendered = await renderIcons(await createSharpRenderer(), readIconSources(repoRoot));
  rendered.forEach((icon) => {
    const file = join(outDir, icon.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, icon.bytes);
  });
  console.log(`Wrote ${rendered.length} icon files under ${outDir}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
