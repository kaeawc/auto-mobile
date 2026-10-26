# ProtoViewer localization and accessibility

ProtoViewer's own chrome uses `ProtoViewer/Localizable.xcstrings`; prototype content and Core/importer diagnostics are not translated. Every catalog key needs a translator comment explaining where it appears and any placeholders, plus an English translated value. Counts use plural variations with `one` and `other`. New view files must add catalog entries. The structural coverage test has an explicit per-file exemption list, including the independently maintained LicensesView until its catalog integration is complete.

The plain-swiftc ProtoViewer build compiles both catalogs with `xcstringstool` into localized bundle resources. `InfoPlist.xcstrings` supplies the local network permission explanation and the unchanged ProtoViewer brand name. The standalone Viewer's headings have accessibility traits and its literals are catalog-covered, but its separate build path does not yet package these catalogs.

Library rows combine their accessible children and switch their date/badge layout to vertical at accessibility Dynamic Type sizes. Layout uses directional alignment. The network provenance band announces that network is enabled for imported prototypes. SwiftUI's labeled controls expose their text rather than a separate decorative symbol announcement; the share sheet uses the system activity controller.

## Manual checks

On an iOS simulator, launch with `-AppleLanguages (ar) -AppleLocale ar_SA` to exercise Arabic locale selection, `-NSDoubleLocalizedStrings YES` for text expansion, and `-NSForceRightToLeftWritingDirection YES` to force RTL. Only English translations currently ship, so Arabic falls back to English. Set the largest accessibility text size with `xcrun simctl ui <udid> content_size accessibility-extra-extra-extra-large` and dark mode with `xcrun simctl ui <udid> appearance dark`. Check every library, settings, error, confirmation, and prototype toolbar state with VoiceOver, including the network band and 44pt control targets.

On Android, exercise the developer pseudolocales `en-XA` and `ar-XB`, increase font scale, enable night mode, and check TalkBack labels and 48dp targets. 

Android strings live in `values/strings.xml`, each with a translator comment (checked by `StringsHygieneTest`); `NoHardcodedChromeStringsTest` fails on a literal in `Text(...)` or `contentDescription`. Debug builds enable pseudolocales. `ChromeA11yMatrixTest` (Robolectric, no new dependency) hosts the library, viewer chrome/status, reset and delete dialogs, the overflow menu and import status in a real activity per cell, across {en, ar-XB, en-XA} x {light, dark} x font scale {1.0, 2.0} x {phone, tablet}. Each cell asserts: no truncated or ellipsized text, a name and a 48dp target on every clickable or toggleable node, a heading, RTL mirroring of the network switch, and that the pseudolocale resources are really loaded. A truncated label (`maxLines = 1` on the row label) was verified to fail the matrix once, then reverted. The Accessibility Test Framework was not added; these checks are in-repo semantics assertions.

## Validation boundaries

No swift-snapshot-testing or ATF dependency is added: host structural tests check catalog coverage, comments, placeholders, and plurals; rendered iOS behavior requires a manual audit. SwiftPM builds only UIKit-free Core and its tests. The macOS-only TypeScript classification list does not apply to these Swift tests.

Acceptance work still required includes an iOS `performAccessibilityAudit` UI smoke test (there is no UI test target), rendered iOS snapshots, localization of shared renderer strings, standalone Viewer resource packaging, catalog entries for new views such as LicensesView, and the device checks above. The coverage scan is a lint-style check rather than a Swift parser; keep interpolation types aligned with extracted `%@` and `%lld` keys when changing expressions.
