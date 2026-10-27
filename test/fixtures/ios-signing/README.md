# iOS signing fixtures (#14099)

Inputs for `IosPackageSigningInspector` and `parseCodesignDisplay` tests.

These files are **transcribed**: they follow the layout of the macOS tools' output but were not
captured from a Mac (the change was written on Linux). Identifiers, hashes, UDIDs and the team id
are placeholders. #14099 asks for captured output, so replace each file with a real capture and
keep the test assertions in sync:

| File                                         | Capture command                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `codesign-dvvv-simulator-adhoc.txt`          | `codesign -dvvv "$(xcrun simctl get_app_container booted dev.jasonpearson.automobile.Playground app)" 2>&1` |
| `codesign-dvvv-development.txt`              | `codesign -dvvv <Playground.app copied with devicectl device copy from> 2>&1`                               |
| `embedded-mobileprovision-development.plist` | `security cms -D -i <Playground.app>/embedded.mobileprovision`                                              |

`codesign -dvvv` prints its display on stderr, so the commands redirect it. Strip
`DeveloperCertificates` data from a captured profile before committing it.
