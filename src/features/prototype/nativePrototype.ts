import { ActionableError } from "../../models/ActionableError";
import { PROTOTYPE_NATIVE_ASSET_URI, PROTOTYPE_NATIVE_URI } from "./nativePrototypeUris";
import { collectPrototypeAssetReferences } from "./prototypeAssetReferences";
import { requiredPrototypeCapabilities } from "./prototypeCapabilityGates";
import type { PrototypeAssetMimeType } from "./prototypeAssets";
import type { ShownSpecJson, ShownSpecRead } from "./PrototypeShownSpecs";
import type { MirroredSavedPrototype } from "./savedPrototypeMirror";
import { renderComposeHostFile, renderSwiftUiHostFile } from "./nativePrototypeTemplates";

/**
 * `automobile:prototype/native` (#13729): everything an app needs to embed a prototype with the
 * published renderer libraries. Only the small host file is generated; the renderer draws the spec.
 */

export const PROTOTYPE_COMPOSE_ARTIFACT =
  "dev.jasonpearson.auto-mobile:auto-mobile-prototype-compose";
export const PROTOTYPE_SWIFT_PACKAGE_URL = "https://github.com/kaeawc/auto-mobile";
export const PROTOTYPE_SWIFT_PRODUCT = "AutoMobilePrototype";

export type NativePrototypePlatform = "android" | "ios";

/** Where the resource finds prototypes; injected so tests need no device or disk. */
export interface NativePrototypeSources {
  /** The spec a device acknowledged for this id, as the prototype tool tracks it. */
  shownSpec(deviceId: string, id: string): ShownSpecRead;
  /** Devices currently showing a prototype with this id. */
  devicesShowing(id: string): string[];
  /** Saved prototypes mirrored on the host for an Android device (carries asset bytes). */
  savedPrototypes(deviceId: string): Promise<MirroredSavedPrototype[]>;
  /** The platform of a device the prototype tool showed on, if known. */
  platformOf(deviceId: string): Promise<NativePrototypePlatform | undefined>;
  /** The release version of this server; the renderer libraries are published at the same one. */
  libraryVersion(): string;
}

export interface NativePrototypeFile {
  path: string;
  content: string;
}
export interface NativePrototypeAsset {
  id: string;
  kind: "image" | "font";
  mimeType?: PrototypeAssetMimeType;
  path: string;
  uri: string;
  /** False when the host has no bytes for this asset; the app must supply them. */
  available: boolean;
}
export type NativePrototypeLibrary =
  | { gradle: string }
  | { swiftPackage: { url: string; from: string; product: string } };
export interface NativePrototype {
  id: string;
  platform: NativePrototypePlatform;
  library: NativePrototypeLibrary;
  requiredCapabilities: string[];
  minimumLibraryVersion: string;
  files: NativePrototypeFile[];
  assets: NativePrototypeAsset[];
  notes: string[];
}

interface ResolvedPrototype {
  deviceId: string;
  spec: ShownSpecJson;
  saved?: MirroredSavedPrototype;
}

const MIME_EXTENSIONS: Record<PrototypeAssetMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "font/ttf": "ttf",
  "font/otf": "otf",
};

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new ActionableError(`${PROTOTYPE_NATIVE_URI} needs ${name}.`);
  }
  return value;
}

function parsePlatform(value: string | undefined): NativePrototypePlatform | undefined {
  if (value === undefined || value === "android" || value === "ios") {
    return value;
  }
  throw new ActionableError(`Unsupported platform "${value}"; use android or ios.`);
}

/** A filesystem-safe directory name for a prototype id (the spec id stays unchanged inside). */
export function prototypeDirectoryName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** A Kotlin/Swift type name for the host file: `checkout-flow` becomes `CheckoutFlowPrototype`. */
export function prototypeHostTypeName(id: string): string {
  const words = id.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return `${/^[A-Za-z]/.test(name) ? name : `P${name}`}Prototype`;
}

/** Asset ids a spec references, by kind, sorted (images first). */
export function referencedAssets(spec: ShownSpecJson): { id: string; kind: "image" | "font" }[] {
  const { images, fonts } = collectPrototypeAssetReferences(spec);
  return [
    ...[...images].sort().map((id) => ({ id, kind: "image" as const })),
    ...[...fonts].sort().map((id) => ({ id, kind: "font" as const })),
  ];
}

async function savedEntry(
  sources: NativePrototypeSources,
  deviceId: string,
  id: string,
): Promise<MirroredSavedPrototype | undefined> {
  const saved = await sources.savedPrototypes(deviceId);
  return saved.find((entry) => entry.id === id);
}

function singleDeviceShowing(sources: NativePrototypeSources, id: string): string {
  const devices = sources.devicesShowing(id);
  if (devices.length === 1) {
    return devices[0];
  }
  if (devices.length === 0) {
    throw new ActionableError(
      `No device is showing prototype "${id}". Show it first, or pass deviceId for a saved prototype.`,
    );
  }
  throw new ActionableError(
    `Prototype "${id}" is shown on ${devices.length} devices (${devices.join(", ")}); pass deviceId.`,
  );
}

/** The shown spec wins (it is what the user saw); a saved prototype supplies the asset bytes. */
async function resolvePrototype(
  sources: NativePrototypeSources,
  id: string,
  deviceIdParam: string | undefined,
): Promise<ResolvedPrototype> {
  const deviceId = deviceIdParam ?? singleDeviceShowing(sources, id);
  const saved = await savedEntry(sources, deviceId, id);
  const shown = sources.shownSpec(deviceId, id);
  if (shown.kind === "known") {
    return { deviceId, spec: shown.spec, saved };
  }
  // A show in flight may replace the saved version, so never serve the saved spec meanwhile.
  if (shown.kind === "busy") {
    throw new ActionableError(
      `A prototype show is in flight on ${deviceId}; read ${PROTOTYPE_NATIVE_URI} again once it finishes.`,
    );
  }
  if (saved) {
    return { deviceId, spec: saved.spec as ShownSpecJson, saved };
  }
  throw new ActionableError(
    `Unknown prototype "${id}" on ${deviceId}: it is neither shown nor saved there.`,
  );
}

async function resolvePlatform(
  sources: NativePrototypeSources,
  requested: NativePrototypePlatform | undefined,
  resolved: ResolvedPrototype,
): Promise<NativePrototypePlatform> {
  // Saved prototypes are mirrored for Android devices only.
  const platform =
    requested ??
    (await sources.platformOf(resolved.deviceId)) ??
    (resolved.saved ? "android" : undefined);
  if (!platform) {
    throw new ActionableError(
      `Cannot tell the platform of ${resolved.deviceId}; pass platform=android or platform=ios.`,
    );
  }
  return platform;
}

function assetPath(platform: NativePrototypePlatform, directory: string, file: string): string {
  return platform === "android"
    ? `app/src/main/assets/prototypes/${directory}/${file}`
    : `Prototypes/${directory}/${file}`;
}

function assetQuery(id: string, assetId: string, deviceId: string): string {
  const params = new URLSearchParams({ id, assetId, deviceId });
  return `${PROTOTYPE_NATIVE_ASSET_URI}?${params.toString()}`;
}

function nativeAssets(
  platform: NativePrototypePlatform,
  id: string,
  resolved: ResolvedPrototype,
): NativePrototypeAsset[] {
  const directory = prototypeDirectoryName(id);
  const mirrored = new Map((resolved.saved?.assets ?? []).map((asset) => [asset.id, asset]));
  return referencedAssets(resolved.spec).map(({ id: assetId, kind }) => {
    const asset = mirrored.get(assetId);
    const extension = asset?.mimeType ? `.${MIME_EXTENSIONS[asset.mimeType]}` : "";
    return {
      id: assetId,
      kind,
      ...(asset?.mimeType ? { mimeType: asset.mimeType } : {}),
      path: assetPath(platform, directory, `${prototypeDirectoryName(assetId)}${extension}`),
      uri: assetQuery(id, assetId, resolved.deviceId),
      available: asset?.bytes !== undefined,
    };
  });
}

function library(platform: NativePrototypePlatform, version: string): NativePrototypeLibrary {
  return platform === "android"
    ? { gradle: `${PROTOTYPE_COMPOSE_ARTIFACT}:${version}` }
    : {
        swiftPackage: {
          url: PROTOTYPE_SWIFT_PACKAGE_URL,
          from: version,
          product: PROTOTYPE_SWIFT_PRODUCT,
        },
      };
}

function notes(
  platform: NativePrototypePlatform,
  capabilities: string[],
  assets: NativePrototypeAsset[],
): string[] {
  const result: string[] = [];
  if (capabilities.includes("prototype_network_v1")) {
    result.push(
      '`request` actions default to via:"host"; pass a host handler to the network option, or they run on the device client.',
    );
  }
  const missing = assets.filter((asset) => !asset.available).map((asset) => asset.id);
  if (missing.length > 0) {
    result.push(
      `The host has no bytes for asset(s) ${missing.join(", ")} (only saved prototypes keep them); add those files yourself.`,
    );
  }
  if (platform === "ios") {
    result.push(
      "Add the Prototypes folder to the app target as a folder reference so Bundle.main finds files by subdirectory.",
    );
  }
  return result;
}

function hostFiles(
  platform: NativePrototypePlatform,
  id: string,
  spec: ShownSpecJson,
  assets: NativePrototypeAsset[],
): NativePrototypeFile[] {
  const directory = prototypeDirectoryName(id);
  const typeName = prototypeHostTypeName(id);
  const input = { id, directory, typeName, assets, storage: spec.storage !== undefined };
  const specFile = {
    path: assetPath(platform, directory, "spec.json"),
    content: JSON.stringify(spec, null, 2),
  };
  return platform === "android"
    ? [
        specFile,
        {
          path: `app/src/main/java/prototypes/${typeName}.kt`,
          content: renderComposeHostFile(input),
        },
      ]
    : // Outside the Prototypes folder reference: Xcode copies that folder as resources and never
      // compiles a Swift file inside it.
      [specFile, { path: `${typeName}.swift`, content: renderSwiftUiHostFile(input) }];
}

/** Builds the native-code payload for one prototype. */
export async function readNativePrototype(
  params: Record<string, string | undefined>,
  sources: NativePrototypeSources,
): Promise<NativePrototype> {
  const id = required(params.id, "id");
  const requested = parsePlatform(params.platform);
  const resolved = await resolvePrototype(sources, id, params.deviceId);
  const platform = await resolvePlatform(sources, requested, resolved);
  const version = sources.libraryVersion();
  const capabilities = requiredPrototypeCapabilities(resolved.spec);
  const assets = nativeAssets(platform, id, resolved);
  return {
    id,
    platform,
    library: library(platform, version),
    requiredCapabilities: capabilities,
    // The renderer libraries publish in lockstep with the server, so the version that authored the
    // spec is the first one guaranteed to render every capability it uses.
    minimumLibraryVersion: version,
    files: hostFiles(platform, id, resolved.spec, assets),
    assets,
    notes: notes(platform, capabilities, assets),
  };
}

/** One saved prototype asset's bytes, for `automobile:prototype/native/asset`. */
export async function readNativePrototypeAsset(
  params: Record<string, string | undefined>,
  sources: NativePrototypeSources,
): Promise<{ mimeType: PrototypeAssetMimeType; bytes: Uint8Array }> {
  const id = required(params.id, "id");
  const assetId = required(params.assetId, "assetId");
  const deviceId = params.deviceId ?? singleDeviceShowing(sources, id);
  const asset = (await savedEntry(sources, deviceId, id))?.assets.find(
    (entry) => entry.id === assetId,
  );
  if (!asset?.bytes || !asset.mimeType) {
    throw new ActionableError(
      `No bytes for asset "${assetId}" of prototype "${id}" on ${deviceId}: the host keeps asset bytes only for saved prototypes. Supply the file yourself.`,
    );
  }
  return { mimeType: asset.mimeType, bytes: asset.bytes };
}
