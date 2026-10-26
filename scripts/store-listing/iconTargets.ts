/**
 * Every icon raster the stores and Android/iOS builds need, derived from one vector source (#14152).
 *
 * The source is a layer pair in `store-listing/icon/`: `background.svg` and `foreground.svg`, both
 * `viewBox="0 0 108 108"` (the Android adaptive-icon canvas; keep the foreground inside the central
 * 66 x 66 safe zone). This table says which raster each consumer gets; `generate-icons.ts` renders it.
 */

/** Where the vector layer pair lives, relative to the repository root. */
export const ICON_SOURCE_DIR = "store-listing/icon";

export type IconLayer = "composite" | "foreground" | "background" | "monochrome";

export type IosAppearance = "any" | "dark" | "tinted";

export interface IconTarget {
  /** Path relative to the output directory. */
  path: string;
  /** Pixel width and height. */
  size: number;
  layer: IconLayer;
  /** Round the corners of the composite (legacy launcher icons on API < 26). */
  roundedLegacy?: boolean;
  /** Apple icons must be opaque; Play's 512 px icon keeps its alpha. */
  opaque?: boolean;
  appearance?: IosAppearance;
}

export const ANDROID_DENSITIES = [
  { name: "mdpi", scale: 1 },
  { name: "hdpi", scale: 1.5 },
  { name: "xhdpi", scale: 2 },
  { name: "xxhdpi", scale: 3 },
  { name: "xxxhdpi", scale: 4 },
] as const;

/** Adaptive layers are 108 dp; the legacy launcher icon is 48 dp. */
const ADAPTIVE_DP = 108;
const LEGACY_DP = 48;

/** Play Console hi-res icon. */
export const PLAY_STORE_ICON_SIZE = 512;

/** App Store marketing icon, and the single size modern asset catalogs need. */
export const IOS_MARKETING_ICON_SIZE = 1024;

/** Solid backdrop for the iOS dark variant; the light background would glare on a dark home screen. */
export const IOS_DARK_BACKGROUND = "#0B1220";

export function androidTargets(): IconTarget[] {
  return ANDROID_DENSITIES.flatMap(({ name, scale }) => {
    const dir = `android/mipmap-${name}`;
    const adaptive = Math.round(ADAPTIVE_DP * scale);
    return [
      { path: `${dir}/ic_launcher_foreground.png`, size: adaptive, layer: "foreground" as const },
      { path: `${dir}/ic_launcher_background.png`, size: adaptive, layer: "background" as const },
      { path: `${dir}/ic_launcher_monochrome.png`, size: adaptive, layer: "monochrome" as const },
      {
        path: `${dir}/ic_launcher.png`,
        size: Math.round(LEGACY_DP * scale),
        layer: "composite" as const,
        roundedLegacy: true,
      },
    ];
  });
}

export function playStoreTargets(): IconTarget[] {
  return [{ path: "android/play-store/icon.png", size: PLAY_STORE_ICON_SIZE, layer: "composite" }];
}

export function iosTargets(): IconTarget[] {
  const size = IOS_MARKETING_ICON_SIZE;
  return [
    {
      path: "ios/AppIcon.appiconset/AppIcon-1024.png",
      size,
      layer: "composite",
      opaque: true,
      appearance: "any",
    },
    {
      path: "ios/AppIcon.appiconset/AppIcon-1024-dark.png",
      size,
      layer: "composite",
      opaque: true,
      appearance: "dark",
    },
    {
      path: "ios/AppIcon.appiconset/AppIcon-1024-tinted.png",
      size,
      layer: "monochrome",
      opaque: true,
      appearance: "tinted",
    },
  ];
}

export function allIconTargets(): IconTarget[] {
  return [...androidTargets(), ...playStoreTargets(), ...iosTargets()];
}

/** `AppIcon.appiconset/Contents.json` for the single-size catalog format (Xcode 14 and later). */
export function iosContentsJson(): string {
  const entry = (filename: string, appearance?: string) => ({
    filename,
    idiom: "universal",
    platform: "ios",
    size: "1024x1024",
    ...(appearance === undefined
      ? {}
      : { appearances: [{ appearance: "luminosity", value: appearance }] }),
  });
  const contents = {
    images: [
      entry("AppIcon-1024.png"),
      entry("AppIcon-1024-dark.png", "dark"),
      entry("AppIcon-1024-tinted.png", "tinted"),
    ],
    info: { author: "xcode", version: 1 },
  };
  return `${JSON.stringify(contents, null, 2)}\n`;
}
