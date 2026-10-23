# Native prototype embedding

The `automobile:prototype/native` resource turns a shown or saved prototype into files a real app
can build: the spec, a short host file and the asset list. The renderer is not generated; the host
file calls the published library (`auto-mobile-prototype-compose` on Android, the
`AutoMobilePrototype` Swift package on iOS), so every spec feature the library supports works
embedded without per-feature code generation.

## Resolution

`src/features/prototype/nativePrototype.ts` resolves the id in this order:

1. The spec a device is showing (`PrototypeShownSpecs`), when exactly one device shows it or
   `deviceId` names one. A show still in flight is an error, never a fallback to an older saved spec.
2. The saved prototype mirror for `deviceId`. Without `deviceId`, a saved-only id is an error,
   because the resource cannot pick a device.

The platform comes from the `platform` parameter, else the device that showed the prototype.

## Generated names

Ids are opaque strings up to 256 characters, but they become directory, file and type names:

- Directory and asset file stems keep the id when it is `[A-Za-z0-9_-]` and at most 64 characters.
  Otherwise they are the sanitized id cut to fit, plus an 8-character SHA-256 prefix of the original
  id, so ids that sanitize alike (`hero/a`, `hero?a`) or share a long prefix stay distinct.
- The host type name is the id in PascalCase plus `Prototype`, with the same hash suffix unless the id
  is plain alphanumeric and short.
- iOS exports refuse asset ids that are canonically equivalent in Unicode (`é` written two ways),
  because Swift compares dictionary keys that way and the generated literal would trap at launch.
  Android keeps both, since JVM strings compare by code unit.

String literals are escaped per language (`nativePrototypeTemplates.ts`): Kotlin uses `\uXXXX` code
units and escapes `$`; Swift uses `\u{X}` scalars.

## Host file contract

- Android reads the spec and assets from `assets/prototypes/<directory>/` with `runCatching`, so a
  missing file falls back to the renderer's load-error view or image placeholder instead of
  crashing composition. The template is ktfmt-stable, so generated hosts pass the Kotlin format
  check unchanged.
- iOS reads them once into `static let` values from the app bundle's `Prototypes/<directory>/`
  folder reference.
- Both hosts pass only `onEvent` and `onDismiss`; error views use the renderer defaults until the
  app edits the host.
- A `storage` block opts the host in to file-backed storage. Requests use the embedded routing
  decision in `docs/decisions/prototype-embedded-request-routing.md`.

## Samples and checks

- `test/fixtures/prototype-embedding/sample.json` is rendered through the resource by
  `scripts/prototype/generateEmbeddingSamples.ts` into `samples/prototype-embedding/` and, for the
  SwiftUI host, the `EmbedConsumer` fixture under `ios/prototype-agent/Fixtures/`.
  `nativePrototypeSamples.test.ts` (and the script's `--check`) fail when they drift from the output.
- The samples are pinned to LF in `.gitattributes` and excluded from oxfmt, so neither a Windows
  checkout nor the formatter can make them differ from the resource output.
- `scripts/android/validate-prototype-compose-consumer.sh` compiles the Android sample against the
  locally published renderer in a minified consumer app; the iOS library build compiles
  `EmbedConsumer`.
