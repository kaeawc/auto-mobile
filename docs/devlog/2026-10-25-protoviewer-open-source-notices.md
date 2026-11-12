# ProtoViewer open-source notice generators

- Kind: decision
- Date: 2026-10-25
- Source: moved from `how-it-works/protoviewer.md`; #14158, #15370
- Shaped: [ProtoViewer](../how-it-works/protoviewer.md)

## Context

Both ProtoViewer apps list the licenses of everything they ship, generated rather than
hand-maintained. No such plugin existed in the Android build before.

## Options

- The AboutLibraries Gradle plugin (`com.mikepenz.aboutlibraries.plugin.android`).
- Google's `oss-licenses-plugin`.
- licensee.

## Decision

Android applies only the AboutLibraries plugin, which collects the release runtime classpath into
`res/raw/aboutlibraries.json`; `LicensesActivity` parses it with the existing kotlinx.serialization
dependency, so the app links no extra runtime library.

## Consequences

- `oss-licenses-plugin` was rejected because its UI is the Play services
  `play-services-oss-licenses` runtime library, which an unprivileged offline app should not link.
- licensee was rejected because it validates licenses but is not a notice generator.
