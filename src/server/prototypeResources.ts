import { ResourceRegistry } from "./resourceRegistry";
import {
  ICON_LOOKUP_LIMIT,
  PROTOTYPE_GUIDE_URI,
  PROTOTYPE_ICONS_TEMPLATE,
  PROTOTYPE_ICONS_URI,
  renderPrototypeGuide,
  searchIcons,
} from "../features/prototype/prototypeGuide";
import { encodeUriSegment } from "../utils/encodeUriSegment";
import {
  readNativePrototype,
  readNativePrototypeAsset,
  type NativePrototypeSources,
} from "../features/prototype/nativePrototype";
import {
  PROTOTYPE_NATIVE_ASSET_TEMPLATE,
  PROTOTYPE_NATIVE_ASSET_URI,
  PROTOTYPE_NATIVE_TEMPLATE,
  PROTOTYPE_NATIVE_URI,
} from "../features/prototype/nativePrototypeUris";
import { defaultSavedPrototypeMirror } from "../features/prototype/savedPrototypeMirror";
import { getMcpServerVersion, releaseVersion } from "../utils/mcpVersion";
import { daemonPrototypeShownSpecs } from "./prototypeTools/registration";

/** Live sources: the prototype tool's shown specs (and the platforms it showed on) and the saved mirror. */
export function defaultNativePrototypeSources(): NativePrototypeSources {
  return {
    shownSpec: (deviceId, id) =>
      daemonPrototypeShownSpecs()?.read(deviceId, id) ?? { kind: "unknown" },
    devicesShowing: (id) => daemonPrototypeShownSpecs()?.devicesShowing(id) ?? [],
    savedPrototypes: (deviceId) => defaultSavedPrototypeMirror().list(deviceId),
    platformOf: async (deviceId) => daemonPrototypeShownSpecs()?.platformOf(deviceId),
    libraryVersion: () => releaseVersion(getMcpServerVersion()),
  };
}

/**
 * Registers the `prototype` authoring guide, its icon lookup (#11052) and the native-code
 * resources (#13729).
 */
export function registerPrototypeResources(
  nativeSources: NativePrototypeSources = defaultNativePrototypeSources(),
): void {
  ResourceRegistry.register(
    PROTOTYPE_GUIDE_URI,
    "Prototype authoring guide",
    "Node and action vocabulary, repeat grammar, limits, theme roles and icon lookup for the prototype tool",
    "text/markdown",
    async () => ({
      uri: PROTOTYPE_GUIDE_URI,
      mimeType: "text/markdown",
      text: renderPrototypeGuide(),
    }),
  );

  ResourceRegistry.registerTemplate(PROTOTYPE_ICONS_TEMPLATE, "Prototype icon lookup", {
    description: `Material icon names containing the query (at most ${ICON_LOOKUP_LIMIT} per read)`,
    mimeType: "application/json",
    handler: async (params: Record<string, string>) => {
      const query = params.query ?? "";
      const { total, names } = searchIcons(query);
      return {
        uri: `${PROTOTYPE_ICONS_URI}?query=${encodeUriSegment(query)}`,
        mimeType: "application/json",
        text: JSON.stringify({ query, total, truncated: total > names.length, names }),
      };
    },
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_NATIVE_TEMPLATE, "Prototype as native app code", {
    description:
      "The prototype's spec, assets and a Jetpack Compose or SwiftUI host file that renders it with the published AutoMobile prototype library",
    mimeType: "application/json",
    handler: async (params: Record<string, string>) => {
      const native = await readNativePrototype(params, nativeSources);
      const query = new URLSearchParams(params).toString();
      return {
        uri: query ? `${PROTOTYPE_NATIVE_URI}?${query}` : PROTOTYPE_NATIVE_URI,
        mimeType: "application/json",
        text: JSON.stringify(native, null, 2),
      };
    },
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_NATIVE_ASSET_TEMPLATE, "Prototype asset bytes", {
    description: "One saved prototype's image or font, base64 encoded",
    mimeType: "application/octet-stream",
    handler: async (params: Record<string, string>) => {
      const asset = await readNativePrototypeAsset(params, nativeSources);
      return {
        uri: `${PROTOTYPE_NATIVE_ASSET_URI}?${new URLSearchParams(params).toString()}`,
        mimeType: asset.mimeType,
        blob: Buffer.from(asset.bytes).toString("base64"),
      };
    },
  });
}
