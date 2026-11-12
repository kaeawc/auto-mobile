# SDK prerequisite captures

- Kind: concept
- Date: 2026-10-31
- Source: moved from `how-it-works/prototype-sdk-matrix.md`; #16064
- Shaped: [Prototype SDK support matrix](../how-it-works/prototype-sdk-matrix.md)

## What was captured

Package, service and framework queries on the runtimes the support matrix covers. Evidence labels:
A is AOSP `default` API 30, B the API 36 Google images, C `google_apis` with GMS disabled, D the
iOS Simulator runtimes.

`default` evidence is API 30 only (A); API 36 AOSP was not installed on the host.
The Google image columns are API 36 (B), with a separate disable probe (C).
The iOS column covers on-disk iOS 26.5/27.0 frameworks (D), not exercised SDK behavior.
All other `unverified` cells lack an SDK host-app run: this includes MapLibre,
MapKit, WebView rendering, Google Maps rendering, bundled ML Kit, Apple Vision,
widgets and tiles. No cross-platform implementation is inferred from an SDK name.
Account, purchase, model-download and physical-device checks were not exercised;
the account/hardware label does not imply compatibility on every platform.

## Captures

| Evidence | Runtime                                                          | Captured fact and its boundary                                                                                                                                                                                                                                            |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A        | AOSP `default`, API 30, arm64 Android 11                         | Package queries found no GMS, Play Store, Maps, Wallet, Chrome or Google WebView. The WebView provider is the AOSP `com.android.webview`, which is not updatable. This is not API 36 evidence.                                                                            |
| A        | AOSP `default`, API 30                                           | `CustomTabsService` resolution found no service; HTTPS `VIEW` resolves to the WebView shell. There is no billing service and no `credential_service` (API 30 predates Credential Manager), and no account is signed in. Glance and tiles are not exercised.               |
| B        | API 36 `google_apis` / `google_apis_playstore`, arm64 Android 16 | GMS and Maps packages are present. Without an SDK app or API key these prerequisites do not establish Maps SDK rendering.                                                                                                                                                 |
| B        | Both API 36 images                                               | The WebView provider is `com.google.android.webview`, which is updatable, and Chrome supplies the Custom Tabs service. Embedding and provider updates are not exercised.                                                                                                  |
| B        | Both API 36 images                                               | `credential_service_primary` names `com.google.android.gms/.auth.api.credentials.credman.service.PasswordAndPasskeyService`. This is a provider setting, not a completed credential flow.                                                                                 |
| B        | API 36 billing and payment prerequisites                         | `google_apis` ships a Play Store stub with no `InAppBillingService.BIND` service; `google_apis_playstore` supplies it. Neither has an account, a Wallet package or NFC/HCE features. Purchases and Google Pay TEST are not exercised.                                     |
| B        | API 36 model delivery                                            | No standalone ML Kit/barcode package is installed; GMS package metadata mentions barcode/ML Kit modules. Bundled inference, unbundled downloads and code-scanner behavior are not exercised.                                                                              |
| B        | API 36 build access                                              | `google_apis` is a userdebug build and allows `adb root`. The Play Store image is a user build.                                                                                                                                                                           |
| C        | API 36 `google_apis`, GMS disabled                               | Disabling GMS for user 0 with `pm disable-user` does not clear the Credential Manager provider setting: it can still name the disabled GMS service, and the resulting behavior is not tested. Billing stays absent.                                                       |
| D        | iOS 26.5 (23F77), 27.0 (24A434)                                  | Runtime roots contain MapKit, WebKit, StoreKit, PassKit, AuthenticationServices, PhotosUI, Vision, VisionKit, AVFoundation, CoreNFC and WidgetKit, and the Maps, Photos and Preferences apps are present. This is framework presence only; SDK behavior is not exercised. |
| D        | iOS WebKit and StoreKit                                          | MobileSafari's version is not a WKWebView version probe. `StoreKitTest` is a toolchain framework and is absent from runtime roots; `SKTestSession` and StoreKit Testing CLI synchronization are not exercised.                                                            |
