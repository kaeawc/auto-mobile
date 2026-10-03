# UIKitCore paste-permission labels

`uikitcore-paste-strings.tsv` is the source-of-truth fixture. Its allow labels were
extracted from installed iOS **16.4, 17.5, 18.0, 18.6, 26.2, 26.5, and 27.1**
simruntimes under `/Library/Developer/CoreSimulator/Volumes/...`. Within each
runtime's `Contents/Resources/RuntimeRoot`, the framework is
`System/Library/PrivateFrameworks/UIKitCore.framework`, and the source file is
`<locale>.lproj/Localizable.strings` (a binary plist). The allow key is
`PASTE_ALLOW_BUTTON_WITHOUT_EXPLANATION_TEXT`, read with `plutil -extract <key> raw`.

Each non-comment TSV row contains the locale, allow label, generic deny label,
and comma-separated runtime versions. The Swift literal retains each unique
allow label and its locale tags; unit tests compare it directly with this fixture.

Allow-label variants recorded in the TSV:

| Locale | Allow label | Runtimes |
| --- | --- | --- |
| ca | Permetre enganxar | 16.4, 17.5 |
| ca | Permet enganxar | 18.0, 18.6, 26.2, 26.5, 27.1 |
| he | אפשר הדבקה | 16.4 |
| he | לאפשר הדבקה | 17.5 |
| he | הרשאת הדבקה | 18.0, 18.6, 26.2, 26.5, 27.1 |
| sk | Povoliť vkladanie | 16.4, 17.5, 18.0 |
| sk | Povoliť vloženie | 18.6, 26.2, 26.5, 27.1 |

The third column comes from UIKitCore's **generic “Don’t Allow” key**, not the
paste alert's own “Don't Allow Paste”-style deny button. It is used only for
negative tests. Greek (`el`) has two rows because its generic deny label changes
in 27.1; its allow label is unchanged. All recorded allow variants are retained.

To re-extract the allow labels from installed runtimes, this Bash loop prints the
runtime path, locale, and label (it does not regenerate the deny column or group
runtime versions). This is a reproduction recipe, not a claim that it was run
during this change:

```bash
for runtime in /Library/Developer/CoreSimulator/Volumes/*/Library/Developer/CoreSimulator/Profiles/Runtimes/*.simruntime; do
  framework="$runtime/Contents/Resources/RuntimeRoot/System/Library/PrivateFrameworks/UIKitCore.framework"
  for strings in "$framework"/*.lproj/Localizable.strings; do
    [[ -f "$strings" ]] || continue
    locale="${strings%/Localizable.strings}"
    locale="${locale##*/}"
    locale="${locale%.lproj}"
    label=$(plutil -extract PASTE_ALLOW_BUTTON_WITHOUT_EXPLANATION_TEXT raw -o - "$strings") || continue
    printf '%s\t%s\t%s\n' "$runtime" "$locale" "$label"
  done
done
```
