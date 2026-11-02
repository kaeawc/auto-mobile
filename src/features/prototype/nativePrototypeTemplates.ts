/**
 * The only per-platform code `automobile:prototype/native` generates (#13729): one host file that
 * loads the bundled spec and assets and hands them to the published renderer. New spec features
 * need no change here; the renderer libraries draw them.
 */
export interface HostFileAsset {
  id: string;
  kind: "image" | "font";
  path: string;
}
export interface HostFileInput {
  id: string;
  /** Directory under the app's prototype assets holding spec.json and the asset files. */
  directory: string;
  typeName: string;
  assets: readonly HostFileAsset[];
  /** Whether the spec declares a storage block, so the host opts in to file-backed storage. */
  storage: boolean;
  /** Set for the single-file Compose/SwiftUI resources: the spec is compiled into the file. */
  inline?: InlineHostSource;
}

/** What a single-file host adds to the bundle host: spec constant, header and sized preview. */
export interface InlineHostSource {
  /** The spec JSON compiled into the file instead of read from the app bundle. */
  readonly spec: string;
  /** The resource URI the file was generated from, named in its doc comment. */
  readonly generatedBy: string;
  /** Comment lines written above the file (library, capabilities, asset URIs). */
  readonly header: readonly string[];
  readonly preview: { readonly name: string; readonly widthDp: number; readonly heightDp: number };
}

/**
 * A double-quoted string literal that compiles in both Kotlin and Swift: printable ASCII passes
 * through (with the quote, backslash and Kotlin's `$` escaped), everything else is a Unicode
 * escape in the target language's own form. Lone surrogates have no scalar and become U+FFFD.
 */
function stringLiteral(value: string, language: "kotlin" | "swift"): string {
  return `"${escapedChars(value, language).join("")}"`;
}

/** {@link stringLiteral}'s escaped body, one entry per code point. */
function escapedChars(value: string, language: "kotlin" | "swift"): string[] {
  return [...value.toWellFormed()].map((char) => {
    if (char === '"' || char === "\\" || (char === "$" && language === "kotlin")) {
      return `\\${char}`;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code < 0x7f) {
      return char;
    }
    if (language === "swift") {
      return `\\u{${code.toString(16)}}`;
    }
    // Kotlin's \uXXXX takes UTF-16 code units, so astral characters become surrogate pairs.
    return [...Array.from({ length: char.length }, (_, i) => char.charCodeAt(i))]
      .map((unit) => `\\u${unit.toString(16).padStart(4, "0")}`)
      .join("");
  });
}

function literal(value: string): string {
  return stringLiteral(value, "kotlin");
}

function swiftLiteral(value: string): string {
  return stringLiteral(value, "swift");
}

/**
 * A JVM class-file string constant holds at most 65535 bytes, so a long spec becomes several
 * escaped (pure ASCII) literals joined at runtime.
 */
const MAX_KOTLIN_LITERAL_CHARS = 16_384;

function kotlinLiteralChunks(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const piece of escapedChars(value, "kotlin")) {
    if (current.length + piece.length > MAX_KOTLIN_LITERAL_CHARS) {
      chunks.push(`"${current}"`);
      current = "";
    }
    current += piece;
  }
  return [...chunks, `"${current}"`];
}

function kotlinSpecConstant(spec: string): string {
  const chunks = kotlinLiteralChunks(spec);
  if (chunks.length === 1) {
    return `private const val SPEC = ${chunks[0]}`;
  }
  return `private val SPEC =\n  listOf(\n${chunks.map((chunk) => `      ${chunk},`).join("\n")}\n    )\n    .joinToString("")`;
}

/** The header comment lines above a single-file host, or nothing for the bundle host. */
function headerComment(inline: InlineHostSource | undefined): string {
  return inline
    ? inline.header.map((line) => (line ? `// ${line}` : "//")).join("\n") + "\n\n"
    : "";
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isFont(asset: HostFileAsset): boolean {
  return asset.kind === "font";
}

function kotlinAssetMap(assets: readonly HostFileAsset[]): string {
  if (assets.length === 0) {
    return " emptyMap()";
  }
  // A missing file reads as null and is left out, so the renderer uses its missing-asset fallback.
  // One entry per line with a trailing comma: the layout ktfmt keeps.
  const entries = assets.map(
    (asset) =>
      `              read(${literal(`$DIRECTORY/${fileName(asset.path)}`).replace("\\$DIRECTORY", "$DIRECTORY")})?.let { ${literal(asset.id)} to it },`,
  );
  return `\n          listOfNotNull(\n${entries.join("\n")}\n            )\n            .toMap()`;
}

export function renderComposeHostFile(input: HostFileInput): string {
  const images = input.assets.filter((asset) => !isFont(asset));
  const fonts = input.assets.filter(isFont);
  const storage = input.storage
    ? "remember(context) { PrototypeStorage.fileBacked(context) }"
    : "PrototypeStorage.None";
  const { inline } = input;
  return `${headerComment(inline)}package prototypes

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
${inline ? "import androidx.compose.ui.tooling.preview.Preview\n" : ""}import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.PrototypeAssets
import dev.jasonpearson.automobile.prototype.PrototypeDismissReason
import dev.jasonpearson.automobile.prototype.PrototypeNetwork
import dev.jasonpearson.automobile.prototype.PrototypeStorage

/** The app assets directory holding this prototype's spec.json and asset files. */
private const val DIRECTORY = ${literal(`prototypes/${input.directory}`)}
${inline ? `\n/** The prototype spec JSON, compiled in. */\n${kotlinSpecConstant(inline.spec)}\n` : ""}
/**
 * The ${input.directory} prototype, drawn by the AutoMobile prototype renderer. Generated by
 * ${inline ? `${inline.generatedBy}: the spec is inlined above and the assets live under\n * assets/prototypes/${input.directory}.` : `automobile:prototype/native: the spec and assets live under assets/prototypes/${input.directory}.`}
 */
@Composable
fun ${input.typeName}(
  modifier: Modifier = Modifier,
  network: PrototypeNetwork = remember { PrototypeNetwork() },
  onEvent: (PrototypeEvent) -> Unit = {},
  onDismiss: (PrototypeDismissReason) -> Unit = {},
) {
  val context = LocalContext.current
  val read = { path: String -> context.readAsset(path) }
${
  inline
    ? "  val spec = SPEC"
    : `  // An empty spec (missing file) shows the renderer's load-error view instead of crashing.
  val spec = remember(context) { read("$DIRECTORY/spec.json")?.decodeToString().orEmpty() }`
}
  val assets =
    remember(context) {
      PrototypeAssets(
        images =${kotlinAssetMap(images)},
        fonts =${kotlinAssetMap(fonts)},
      )
    }
  AutoMobilePrototype(
    spec = spec,
    modifier = modifier,
    assets = assets,
    storage = ${storage},
    network = network,
    onEvent = onEvent,
    onDismiss = onDismiss,
  )
}

/** A bundled file's bytes, or null when the app does not ship it. */
private fun Context.readAsset(path: String): ByteArray? = runCatching {
  assets.open(path).use { it.readBytes() }
}
  .getOrNull()
${inline ? composePreview(input.typeName, inline) : ""}`;
}

function composePreview(typeName: string, inline: InlineHostSource): string {
  const { name, widthDp, heightDp } = inline.preview;
  return `
@Preview(name = ${literal(name)}, widthDp = ${Math.round(widthDp)}, heightDp = ${Math.round(heightDp)})
@Composable
private fun ${typeName}Preview() {
  ${typeName}()
}
`;
}

function swiftAssetMap(assets: readonly HostFileAsset[]): string {
  if (assets.length === 0) {
    return "[:]";
  }
  const entries = assets.map(
    (asset) => `${swiftLiteral(asset.id)}: resource(${swiftLiteral(fileName(asset.path))})`,
  );
  return `[${entries.join(", ")}]`;
}

export function renderSwiftUiHostFile(input: HostFileInput): string {
  const images = input.assets.filter((asset) => !isFont(asset));
  const fonts = input.assets.filter(isFont);
  const { inline } = input;
  return `${headerComment(inline)}import AutoMobilePrototype
import Foundation
import SwiftUI

/// The ${input.directory} prototype, drawn by the AutoMobile prototype renderer. Generated by
${inline ? `/// ${inline.generatedBy}: the spec is inlined below and the assets live in\n/// Prototypes/${input.directory}.` : `/// automobile:prototype/native: the spec and assets live in Prototypes/${input.directory}.`}
struct ${input.typeName}: View {
    var network: PrototypeNetworkConfiguration = .default
    var onEvent: @MainActor (PrototypeEvent) -> Void = { _ in }
    var onDismiss: @MainActor (PrototypeDismissReason) -> Void = { _ in }

    // Read once per process, not on every body evaluation.
    private static let spec = ${inline ? `Data(${swiftLiteral(inline.spec)}.utf8)` : 'resource("spec.json")'}
    private static let assets = PrototypeAssets(images: ${swiftAssetMap(images)}, fonts: ${swiftAssetMap(fonts)})

    var body: some View {
        AutoMobilePrototypeView(
            spec: Self.spec,
            assets: Self.assets,
            storage: ${input.storage ? ".fileBacked" : ".none"},
            network: network,
            onEvent: onEvent,
            onDismiss: onDismiss
        )
    }

    /// Bundled file bytes; a missing spec shows the renderer's load-error view instead of a blank screen.
    private static func resource(_ name: String) -> Data {
        let url = Bundle.main.bundleURL
            .appendingPathComponent(${swiftLiteral(`Prototypes/${input.directory}`)})
            .appendingPathComponent(name)
        return (try? Data(contentsOf: url)) ?? Data()
    }
}
${inline ? swiftUiPreview(input.typeName, inline) : ""}`;
}

function swiftUiPreview(typeName: string, inline: InlineHostSource): string {
  const { name, widthDp, heightDp } = inline.preview;
  return `
#Preview(${swiftLiteral(name)}) {
    ${typeName}()
        .frame(width: ${widthDp}, height: ${heightDp})
}
`;
}
