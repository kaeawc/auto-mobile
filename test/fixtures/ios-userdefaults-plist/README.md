# Host-generated UserDefaults plist fixtures

Captured on macOS 26.6.2 (build 25G83), reported by `/usr/bin/sw_vers`.
No simulator/device commands were used. Tests read the XML captures directly;
the source XML and binary plist are scratch artifacts, not test process inputs.
`plutil` serializes the inserted 3.0 as `<real>3</real>`; its real tag must survive.

Exact generation commands, from the repository root:

```bash
/usr/bin/sw_vers
mkdir -p scratch/ios-userdefaults-fixtures test/fixtures/ios-userdefaults-plist
/usr/bin/plutil -create xml1 scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert integer -integer 42 scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert real -float 3.0 scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert bigInteger -integer 9007199254740993 scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert yes -bool true scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert no -bool false scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert string -string '  C:\tmp
' scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert unicode -string 'こんにちは 🌈 café' scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert 'key\.with\.dots' -string dotted scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert date -date 2026-10-01T12:34:56Z scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert data -data aGVsbG8= scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert array -json '[1,"two",true]' scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -insert dictionary -json '{"nested":3,"text":"three"}' scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -convert xml1 -o - scratch/ios-userdefaults-fixtures/source.plist > test/fixtures/ios-userdefaults-plist/xml-origin.plist
/usr/bin/plutil -convert binary1 -o scratch/ios-userdefaults-fixtures/binary.plist scratch/ios-userdefaults-fixtures/source.plist
/usr/bin/plutil -convert xml1 -o - scratch/ios-userdefaults-fixtures/binary.plist > test/fixtures/ios-userdefaults-plist/binary-origin.plist
```

The XML-format captures use `.plist` so the generic `*.xml` validation gate
does not attempt to fetch Apple's network DTD. Captured bytes are unchanged.

## Non-finite reals

Host `plutil -insert ... -float nan/inf/-inf` succeeded but silently emitted
`<real>0.0</real>` for all three keys. These scratch-only probes were:

```bash
mkdir -p scratch/third-pass
/usr/bin/plutil -create xml1 scratch/third-pass/non-finite-source.plist
/usr/bin/plutil -insert nan -float nan scratch/third-pass/non-finite-source.plist
/usr/bin/plutil -insert positiveInfinity -float inf scratch/third-pass/non-finite-source.plist
/usr/bin/plutil -insert negativeInfinity -float -inf scratch/third-pass/non-finite-source.plist
/usr/bin/plutil -convert xml1 -o - scratch/third-pass/non-finite-source.plist
```

The additional fixtures are **captured plutil output from constructed XML input**,
not a simulator capture or direct hand-authored output. The host accepted `nan`,
`inf`, and `-inf` in XML and emitted `nan`, `+infinity`, and `-infinity` respectively.
A binary round trip retained all three spellings, including nested array values.
Exact capture commands:

```bash
cat > scratch/third-pass/non-finite-hand-input.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>nan</key><real>nan</real>
<key>positiveInfinity</key><real>inf</real>
<key>negativeInfinity</key><real>-inf</real>
<key>nested</key><array><real>nan</real><real>inf</real><real>-inf</real></array>
</dict></plist>
EOF
/usr/bin/plutil -convert xml1 -o - scratch/third-pass/non-finite-hand-input.plist > test/fixtures/ios-userdefaults-plist/non-finite-origin.plist
/usr/bin/plutil -convert binary1 -o scratch/third-pass/non-finite-hand-binary.plist scratch/third-pass/non-finite-hand-input.plist
/usr/bin/plutil -convert xml1 -o - scratch/third-pass/non-finite-hand-binary.plist > test/fixtures/ios-userdefaults-plist/non-finite-binary-origin.plist
```
