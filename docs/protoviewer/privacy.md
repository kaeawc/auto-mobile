# ProtoViewer privacy

ProtoViewer (iOS and Android) shows prototypes you import. It has no accounts, no analytics, no
advertising and no crash-reporting service. Everything it stores stays on your device. This page is
the privacy policy for the app and the source of the App Store and Google Play privacy answers.

## What the app does with your data

- **Stored on the device only.** Imported prototypes (spec, images, fonts), the library list, each
  prototype's own saved state, and one setting ("Allow network for imported prototypes").
- **No data is sent to AutoMobile or any third party by the app itself.**
- **Backups.** Android excludes every domain from cloud backup and device transfer
  (`allowBackup=false`, `fullBackupContent=false`, `data_extraction_rules.xml`). iOS keeps the app's
  data in its own container; the app adds no sync service.
- **Export.** Sharing a prototype writes a clean bundle (spec plus the assets it references) to the
  system share sheet. It never contains the prototype's saved state, your library list, a source
  URL or when you opened it. You choose the destination.
- **Delete everything.** Delete a prototype in the library to remove its spec, assets and saved
  state. Uninstalling the app removes all remaining data.

## Network requests made by imported prototypes

A prototype can contain `request` actions that call a web service. The app blocks all of them
until you turn on **Allow network for imported prototypes** (off by default). When it is on:

- Requests go from your device directly to the host the prototype names; AutoMobile does not proxy
  or log them.
- Loopback, link-local and AutoMobile daemon addresses are blocked. Local-network addresses are
  allowed, so iOS asks for local network permission and Android 17 (API 37) asks for
  `ACCESS_LOCAL_NETWORK` the first time. Declining turns the switch back off.
- A banner stays visible while the network is on. Turning it off cancels requests in flight.

Treat an imported prototype like any file you open: turn the switch on only for prototypes you trust.

## iOS privacy manifests

The library target `AutoMobilePrototype` and the ProtoViewer app each carry a
`PrivacyInfo.xcprivacy` (`ios/prototype-agent/Sources/` and `ios/prototype-agent/ProtoViewer/`).
Both declare `NSPrivacyTracking = false`, no tracking domains and no collected data types. The
required-reason API declarations are:

| Category                                                      | Reason             | Where the code uses it                                                                                             |
| ------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| System Boot Time (`systemUptime`)                             | `35F9.1`           | Measuring elapsed time for request timing, timeouts and capture holds                                              |
| File Timestamp (`stat`, `lstat`, `fstat`, `attributesOfItem`) | `C617.1`, `3B52.1` | Checking type and size of files in the app container and of a file you choose to import; timestamps are never read |
| User Defaults                                                 | `CA92.1`           | The app's own network switch (key `allowImportedPrototypeNetwork`)                                                 |

Disk space and active keyboards are not used. `scripts/ios/check-privacy-manifests.ts` (Fast
Validation check `privacy-manifests`) scans the Swift sources and fails when an API in Apple's
required-reason list is used without a matching entry, when an entry has no valid reason code, when
an entry is stale, or when a manifest declares tracking or collected data. It runs in the pull
request and in `scripts/prepush-ios.sh`. When you add such an API, add the entry to both manifests
(or only the app manifest for code outside the library target) and pick a reason from Apple's
documentation.

Embedders of the `AutoMobilePrototype` library inherit the library manifest as a bundled resource.

## App Store Connect: App Privacy

| Question                                                        | Answer                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Do you or your third-party partners collect data from this app? | **No, we do not collect data from this app.** ("Data Not Collected") |
| Tracking                                                        | None                                                                 |
| Third-party SDKs                                                | None linked                                                          |

This holds as long as the app keeps third-party SDKs out. If a crash or analytics SDK is ever added,
update this page and both manifests before shipping. The privacy policy URL is this page once the
docs site is published, entered in App Store Connect and linked from the in-app About screen
(tracked in #14144).

## Google Play: Data safety

| Section                                                               | Answer                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Does your app collect or share any of the required user data types?   | **No**                                                                            |
| Is all of the user data collected by your app encrypted in transit?   | Not applicable (no data collected)                                                |
| Do you provide a way for users to request that their data is deleted? | Not applicable; data is local and removed by deleting a prototype or uninstalling |
| Data collected and shared                                             | None                                                                              |

Reasoning: no data leaves the device on the app's own behalf. Network requests that an imported
prototype makes, off by default and under your control, go directly to the host that prototype names
and are not collected by us. Declared permissions: `INTERNET` and `ACCESS_LOCAL_NETWORK` (requested
only when you enable imported-prototype networking). Play shows the "no data collected" summary
only when the privacy policy URL on the listing points to this page.

## Verifying before a release

- iOS: archive ProtoViewer, run Xcode's `Generate Privacy Report` and confirm there are no
  missing-reason warnings. The report merges the app and library manifests.
- Android: confirm the merged manifest still has only `INTERNET` and `ACCESS_LOCAL_NETWORK`, and
  that `android/protoviewer/src/main/res/xml/data_extraction_rules.xml` excludes every domain.
- Re-check the table above against `bun scripts/ios/check-privacy-manifests.ts`.
