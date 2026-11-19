// Public types of @kaeawc/auto-mobile-prototype-web (#16453). Hand-written so the package ships no
// internal renderer types; test/features/prototype/web/prototypeWebPackage.typecheck.ts fails when
// they drift from the implementation in src/features/prototype/web/embed/.

export type PrototypeOrientation = "portrait" | "landscape";

export type PrototypeContentSize =
  | "extra-small"
  | "small"
  | "medium"
  | "large"
  | "extra-large"
  | "extra-extra-large"
  | "extra-extra-extra-large"
  | "accessibility-medium"
  | "accessibility-large"
  | "accessibility-extra-large"
  | "accessibility-extra-extra-large"
  | "accessibility-extra-extra-extra-large";

/** `fontScale` applies to an Android frame (0.85 to 2), `contentSize` to an iOS one. */
export interface PrototypeTextSize {
  readonly fontScale?: number;
  readonly contentSize?: PrototypeContentSize;
}

/** The element tree `renderPrototype` returns; its shape is internal and may change. */
export interface PrototypeElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly style: Readonly<Record<string, string>>;
  readonly children: readonly (PrototypeElement | string)[];
}

/** A node drawn as a placeholder. */
export interface PrototypeUnsupportedNode {
  readonly type: string;
  readonly id?: string;
  readonly path: string;
  readonly reason:
    | "unsupportedType"
    | "assetNotInlined"
    | "assetOverBudget"
    | "shaderFallback"
    | "iconMissing";
  readonly asset?: string;
}

export type PrototypeWebErrorCode =
  | "unknownVersion"
  | "missingCapabilities"
  | "invalidInput"
  | "invalidOption";

export interface PrototypeWebError {
  readonly code: PrototypeWebErrorCode;
  readonly message: string;
  /** For `missingCapabilities`: the required capabilities this release lacks, sorted. */
  readonly missing: readonly string[];
  readonly libraryVersion: string;
}

/** Thrown by `renderPrototype` when it refuses its input. */
export declare class PrototypeWebRefusal extends Error {
  readonly error: PrototypeWebError;
  constructor(code: PrototypeWebErrorCode, message: string, missing?: readonly string[]);
}

export interface PrototypeFrameInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export type PrototypeFrameCutout =
  | { readonly type: "none" }
  | {
      readonly type: "punchHole";
      readonly centerXDp: number;
      readonly centerYDp: number;
      readonly radiusDp: number;
    }
  | {
      readonly type: "notch" | "island";
      readonly centerXDp: number;
      readonly centerYDp: number;
      readonly widthDp: number;
      readonly heightDp: number;
    };

export interface PrototypeFramePanelFields {
  readonly screen: {
    readonly widthDp: number;
    readonly heightDp: number;
    readonly density: number;
  };
  readonly cornerRadiusDp: number;
  readonly cutout: PrototypeFrameCutout;
  readonly statusBarDp: number;
  readonly navBar:
    | { readonly type: "none" }
    | { readonly type: "gesture" | "buttons"; readonly heightDp: number };
  readonly safeArea: {
    readonly portrait: PrototypeFrameInsets;
    readonly landscape: PrototypeFrameInsets;
  };
}

export type PrototypeFramePanelRole = "inner" | "cover" | "rear" | "external";
export type PrototypeFramePosture =
  | "closed"
  | "half_opened"
  | "opened"
  | "rear_display"
  | "flipped"
  | "tent";

/**
 * A custom device frame: an entry as the renderer's `deviceFrames.json` writes one. It is checked
 * as strictly as the registry, and an invalid one is refused with `invalidOption` naming its path.
 */
export interface PrototypeWebFrame extends PrototypeFramePanelFields {
  readonly id: string;
  readonly platform: "android" | "ios";
  readonly label: string;
  readonly formFactor?: "phone" | "tablet" | "foldable" | "tv" | "watch" | "automotive";
  /** The panels besides the `inner` one the top-level fields describe. */
  readonly panels?: readonly ({
    readonly role: Exclude<PrototypeFramePanelRole, "inner">;
  } & PrototypeFramePanelFields)[];
  readonly hinge?: {
    readonly axis: "vertical" | "horizontal";
    readonly panel?: PrototypeFramePanelRole;
    readonly positionDp: number;
    readonly widthDp: number;
    readonly occluding: boolean;
  };
  readonly postures?: readonly {
    readonly posture: PrototypeFramePosture;
    readonly panel: PrototypeFramePanelRole;
    readonly hingeDegrees: number;
  }[];
  readonly mask?: "rect" | "round";
  readonly input?: "touch" | "dpad" | "rotary";
  readonly frame: { readonly bezelDp: number; readonly color: string };
}

export interface PrototypeRenderOptions {
  /** A device frame id (default `pixel-9`), a frame object, or `false` for the screen alone. */
  readonly frame?: string | PrototypeWebFrame | false;
  readonly orientation?: PrototypeOrientation;
  readonly mode?: "light" | "dark";
  readonly screen?: string;
  readonly locale?: string;
  readonly textSize?: PrototypeTextSize;
  /** Parses envelope glyph markup into shapes; without one, icons draw a placeholder. */
  readonly parseGlyph?: (markup: string) => readonly PrototypeElement[] | undefined;
}

export interface PrototypeRenderedStack {
  readonly start: string;
  readonly screens: readonly string[];
  readonly screen: string;
}

export interface PrototypeRendered {
  readonly element: PrototypeElement;
  readonly frame: string | false;
  readonly orientation: PrototypeOrientation;
  readonly orientations: readonly PrototypeOrientation[];
  readonly unsupportedNodes: readonly PrototypeUnsupportedNode[];
  readonly stack?: PrototypeRenderedStack;
}

/** Draws a spec or embed envelope as an element tree, with no DOM. */
export declare function renderPrototype(
  spec: unknown,
  options?: PrototypeRenderOptions,
): PrototypeRendered;

export type PrototypeWebControl = "rotate" | "zoom" | "screen";
export type PrototypeWebZoom = "fit" | number;

export interface PrototypeViewState {
  readonly frame: string | false;
  readonly orientation: PrototypeOrientation;
  readonly zoom: PrototypeWebZoom;
  readonly scale: number;
  readonly mode: "light" | "dark";
  readonly screen?: string;
  readonly screens: readonly string[];
  readonly unsupportedNodes: readonly PrototypeUnsupportedNode[];
  readonly error?: PrototypeWebError;
}

export interface PrototypeMountEvents {
  readonly onRender?: (detail: {
    readonly unsupportedNodes: readonly PrototypeUnsupportedNode[];
  }) => void;
  readonly onScreenChange?: (detail: { readonly screen: string }) => void;
  readonly onOrientationChange?: (detail: { readonly orientation: PrototypeOrientation }) => void;
  readonly onZoomChange?: (detail: {
    readonly zoom: PrototypeWebZoom;
    readonly scale: number;
  }) => void;
  readonly onError?: (detail: PrototypeWebError) => void;
}

export interface PrototypeMountOptions extends PrototypeMountEvents {
  /** A prototype spec, or an `automobile-prototype-embed` envelope. */
  readonly spec: unknown;
  readonly frame?: string | PrototypeWebFrame | false;
  readonly orientation?: PrototypeOrientation;
  readonly zoom?: PrototypeWebZoom;
  readonly mode?: "light" | "dark" | "system";
  readonly screen?: string;
  readonly controls?: false | readonly PrototypeWebControl[];
  readonly locale?: string;
  readonly textSize?: PrototypeTextSize;
}

export interface PrototypeMountHandle {
  update(options: Partial<PrototypeMountOptions>): void;
  destroy(): void;
  readonly state: PrototypeViewState;
}

/** Draws a prototype into a shadow root on `host`. */
export declare function mount(
  host: HTMLElement,
  options: PrototypeMountOptions,
): PrototypeMountHandle;

export declare const PROTOTYPE_WEB_LIBRARY_VERSION: string;
/** Every capability an embed envelope's `requires` can name that this release draws. */
export declare const PROTOTYPE_WEB_CAPABILITIES: readonly string[];
