import {
  ABSOLUTE,
  ALIGN_ITEMS,
  ALIGN_SELF,
  ARIA_HIDDEN,
  ARIA_LABEL,
  ASPECT_RATIO,
  BACKGROUND_COLOR,
  BORDER_RADIUS,
  BOX_SHADOW,
  CENTER,
  DATA_PART,
  FLEX,
  FLEX_SHRINK,
  FONT_SIZE,
  FONT_WEIGHT,
  JUSTIFY_CONTENT,
  MIN_WIDTH,
  RELATIVE,
  STRETCH,
  Z_INDEX,
} from "./webCss";
import { record, type Raw } from "../prototypeTemplate";
import { el, type WebChild, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { cssColor } from "./webStyle";

type Css = Record<string, string>;

/** 24-unit glyph paths, drawn inline so the page fetches nothing. */
const GLYPHS = {
  play: "M8 5v14l11-7z",
  fullscreen: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  cast: "M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z",
  airplay:
    "M6 22h12l-6-6zM21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z",
} as const;

export function glyph(name: keyof typeof GLYPHS, size: number): WebElement {
  return el(
    "svg",
    {
      attrs: {
        viewBox: "0 0 24 24",
        width: String(size),
        height: String(size),
        [ARIA_HIDDEN]: "true",
      },
      style: { display: "block", [FLEX_SHRINK]: "0" },
    },
    [el("path", { attrs: { d: GLYPHS[name], fill: "currentColor" } })],
  );
}

/** Seven SMPTE-style bars: the synthetic frame for a `colorBars` sample and the camera's scene. */
const BARS = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
const BARS_CSS = `linear-gradient(to right,${BARS.map(
  (color, index) =>
    `${color} ${((index * 100) / 7).toFixed(3)}% ${(((index + 1) * 100) / 7).toFixed(3)}%`,
).join(",")})`;

/** `m:ss` from milliseconds, as both platforms' players label their position. */
export function mediaTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const fills: Css = { position: ABSOLUTE, inset: "0" };

/** The node's inline source, else the source of the declared `media.players` entry it names. */
function videoSource(node: Raw, scope: WebRenderScope): unknown {
  if (node.source !== undefined) {
    return node.source;
  }
  const players = record(record(scope.spec.media)?.players);
  return typeof node.player === "string" && players && Object.hasOwn(players, node.player)
    ? record(players[node.player])?.source
    : undefined;
}

/** The frame a video shows before playback: a built-in sample's synthetic frame, else black. */
function videoFrame(node: Raw, scope: WebRenderScope): WebElement {
  const sample = record(videoSource(node, scope))?.sample;
  if (sample === "colorBars") {
    return el("div", {
      attrs: { [DATA_PART]: "frame" },
      style: { ...fills, background: BARS_CSS },
    });
  }
  const countdown =
    sample === "countdown"
      ? [el("span", { style: { [FONT_SIZE]: "48px", [FONT_WEIGHT]: "700" } }, ["3"])]
      : [];
  return el(
    "div",
    {
      attrs: { [DATA_PART]: "frame" },
      style: {
        ...fills,
        display: FLEX,
        [ALIGN_ITEMS]: CENTER,
        [JUSTIFY_CONTENT]: CENTER,
        color: "#fff",
      },
    },
    countdown,
  );
}

/** The caption toggle, labelled with every track, when the player has captions. */
function captionButton(node: Raw): WebChild[] {
  const tracks = Array.isArray(node.captions) ? node.captions.map(record) : [];
  const labels = tracks.flatMap((track) => (typeof track?.label === "string" ? [track.label] : []));
  if (labels.length === 0) {
    return [];
  }
  return [
    el(
      "span",
      {
        attrs: {
          role: "button",
          [ARIA_LABEL]: `Captions: ${labels.join(", ")}`,
          [DATA_PART]: "captions",
        },
        style: {
          border: "1.5px solid currentColor",
          [BORDER_RADIUS]: "3px",
          padding: "0 3px",
          [FONT_SIZE]: "10px",
          [FONT_WEIGHT]: "700",
        },
      },
      ["CC"],
    ),
  ];
}

/** The scrubber at the start position: a played and an unplayed part. */
function scrubber(played: string): WebElement {
  return el("span", {
    attrs: { [DATA_PART]: "scrubber" },
    style: {
      flex: "1 1 auto",
      height: "4px",
      [BORDER_RADIUS]: "2px",
      background: `linear-gradient(to right,#fff ${played},rgba(255,255,255,0.35) ${played})`,
    },
  });
}

/** The bottom control row: play (iOS only, Android centres it), time, scrubber, captions, fullscreen. */
function controlRow(node: Raw, ios: boolean): WebElement {
  const start = typeof node.startMs === "number" ? node.startMs : 0;
  return el(
    "div",
    {
      attrs: { [DATA_PART]: "controls" },
      style: {
        position: ABSOLUTE,
        left: ios ? "8px" : "0",
        right: ios ? "8px" : "0",
        bottom: ios ? "8px" : "0",
        display: FLEX,
        [ALIGN_ITEMS]: CENTER,
        gap: "8px",
        padding: "6px 12px",
        color: "#fff",
        [FONT_SIZE]: "12px",
        ...(ios
          ? { [BACKGROUND_COLOR]: "rgba(60,60,67,0.6)", [BORDER_RADIUS]: "12px" }
          : { background: "linear-gradient(to top,rgba(0,0,0,0.6),transparent)" }),
      },
    },
    [
      ...(ios ? [glyph("play", 20)] : []),
      el("span", { attrs: { [DATA_PART]: "time" } }, [mediaTime(start)]),
      scrubber(start > 0 ? "2%" : "0%"),
      ...captionButton(node),
      glyph("fullscreen", 20),
    ],
  );
}

/** Android's centred play button: a 56 px translucent circle. */
function centredPlay(): WebElement {
  return el(
    "span",
    {
      attrs: { role: "button", [ARIA_LABEL]: "Play", [DATA_PART]: "play" },
      style: {
        position: ABSOLUTE,
        left: "50%",
        top: "50%",
        transform: "translate(-50%,-50%)",
        width: "56px",
        height: "56px",
        [BORDER_RADIUS]: "50%",
        [BACKGROUND_COLOR]: "rgba(0,0,0,0.5)",
        color: "#fff",
        display: FLEX,
        [ALIGN_ITEMS]: CENTER,
        [JUSTIFY_CONTENT]: CENTER,
      },
    },
    [glyph("play", 32)],
  );
}

/**
 * A video player before playback: the source's first frame (a built-in sample draws its own
 * synthetic frame; other sources are not inlined and show black) and the skin's player chrome at
 * `startMs`, unless `controls` is `none`. A poster asset is not inlined, so it is listed as such.
 */
const videoPlayerRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope, path) => {
    if (typeof node.poster === "string") {
      scope.unsupported.push({
        type: "videoPlayer",
        ...(typeof node.id === "string" ? { id: node.id } : {}),
        path,
        reason: "assetNotInlined",
      });
    }
    const ios = scope.condition.platform === "ios";
    const { attrs, style } = kit.base(node, scope, {
      position: RELATIVE,
      overflow: "hidden",
      [BACKGROUND_COLOR]: "#000",
      [ASPECT_RATIO]: "16 / 9",
      [ALIGN_SELF]: STRETCH,
    });
    const chrome =
      node.controls === "none" ? [] : [...(ios ? [] : [centredPlay()]), controlRow(node, ios)];
    return el("div", { attrs: { [ARIA_LABEL]: "Video player", ...attrs, role: "region" }, style }, [
      videoFrame(node, scope),
      ...chrome,
    ]);
  };

const CAMERA_ASPECT: Readonly<Record<string, string>> = {
  "4:3": "3 / 4",
  "16:9": "9 / 16",
  "1:1": "1 / 1",
};

/**
 * A camera viewfinder in portrait at its `aspectRatio` (default 4:3), showing a synthetic test
 * pattern where a device shows its camera (the emulator's virtual scene on Android), with a label
 * naming the capture mode.
 */
const cameraPreviewRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const aspect = CAMERA_ASPECT[String(node.aspectRatio)] ?? CAMERA_ASPECT["4:3"]!;
    const { attrs, style } = kit.base(node, scope, {
      position: RELATIVE,
      overflow: "hidden",
      [BACKGROUND_COLOR]: "#000",
      [ASPECT_RATIO]: aspect,
      [ALIGN_SELF]: STRETCH,
    });
    const mode = node.mode === "video" ? "video" : "photo";
    const pattern = el("div", {
      attrs: { [DATA_PART]: "test-pattern" },
      style: {
        position: ABSOLUTE,
        left: "0",
        right: "0",
        top: "20%",
        height: "60%",
        background: BARS_CSS,
      },
    });
    const label = el(
      "span",
      {
        attrs: { [DATA_PART]: "label" },
        style: {
          position: ABSOLUTE,
          left: "8px",
          top: "8px",
          padding: "2px 8px",
          [BORDER_RADIUS]: "10px",
          [BACKGROUND_COLOR]: "rgba(0,0,0,0.6)",
          color: "#fff",
          [FONT_SIZE]: "12px",
        },
      },
      [`Camera preview · ${mode}`],
    );
    return el("div", { attrs: { [ARIA_LABEL]: "Camera preview", ...attrs, role: "img" }, style }, [
      pattern,
      label,
    ]);
  };

/**
 * The idle route button per skin (Cast on Android, AirPlay on iOS) in a 48 px target. It is a
 * disclosure, so tapping it opens a simulated device picker that lists no devices, with no script.
 */
const castButtonRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const ios = scope.condition.platform === "ios";
    const tint = cssColor("onSurfaceVariant", scope.style);
    const { attrs, style } = kit.base(node, scope, {
      position: RELATIVE,
      display: "inline-block",
      [FLEX_SHRINK]: "0",
      ...(tint ? { color: tint } : {}),
    });
    const name = ios ? "AirPlay" : "Cast";
    const summary = el(
      "summary",
      {
        attrs: { [ARIA_LABEL]: attrs[ARIA_LABEL] ?? name },
        style: {
          display: FLEX,
          [ALIGN_ITEMS]: CENTER,
          [JUSTIFY_CONTENT]: CENTER,
          width: "48px",
          height: "48px",
          cursor: "pointer",
        },
      },
      [glyph(ios ? "airplay" : "cast", 24)],
    );
    return el("details", { attrs: { ...attrs }, style }, [summary, devicePicker(name, scope)]);
  };

function devicePicker(name: string, scope: WebRenderScope): WebElement {
  const surface = cssColor("surfaceContainerHigh", scope.style) ?? "#ece6f0";
  const text = cssColor("onSurface", scope.style) ?? "#1d1b20";
  return el(
    "div",
    {
      attrs: { role: "dialog", [ARIA_LABEL]: `${name} devices`, [DATA_PART]: "device-picker" },
      style: {
        position: ABSOLUTE,
        top: "48px",
        right: "0",
        [Z_INDEX]: "10",
        [MIN_WIDTH]: "200px",
        padding: "16px",
        [BORDER_RADIUS]: "16px",
        [BACKGROUND_COLOR]: surface,
        color: text,
        [BOX_SHADOW]: "0 2px 6px rgba(0,0,0,0.3)",
      },
    },
    [
      el("div", { style: { [FONT_WEIGHT]: "500", "margin-bottom": "8px" } }, [
        name === "Cast" ? "Cast to" : "AirPlay",
      ]),
      el("div", { style: { [FONT_SIZE]: "14px", opacity: "0.7" } }, ["No devices found"]),
    ],
  );
}

export function webMediaRenderers(kit: WebRenderKit): Record<string, NodeRenderer> {
  return {
    videoPlayer: videoPlayerRenderer(kit),
    cameraPreview: cameraPreviewRenderer(kit),
    castButton: castButtonRenderer(kit),
  };
}
