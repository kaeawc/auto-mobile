# iOS signing fixtures (#14099)

Inputs for `IosPackageSigningInspector` and `parseCodesignDisplay` tests.

`codesign-dvvv-simulator-adhoc.txt` is a real capture from an Xcode-built Playground installed on an
iOS 26.5 Simulator; only the container path and UUIDs are redacted. The other two files are still
**transcribed** (they follow the tools' output layout, with placeholder identifiers, hashes, UDIDs
and team id) because they need a development-signed build on a physical device (#15062). Replace
each with a real capture and keep the test assertions in sync:

| File                                         | Capture command                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `codesign-dvvv-simulator-adhoc.txt`          | `codesign -dvvv "$(xcrun simctl get_app_container booted dev.jasonpearson.automobile.Playground app)" 2>&1` |
| `codesign-dvvv-development.txt`              | `codesign -dvvv <Playground.app copied with devicectl device copy from> 2>&1`                               |
| `embedded-mobileprovision-development.plist` | `security cms -D -i <Playground.app>/embedded.mobileprovision`                                              |

`codesign -dvvv` prints its display on stderr, so the commands redirect it. Strip
`DeveloperCertificates` data from a captured profile before committing it.
