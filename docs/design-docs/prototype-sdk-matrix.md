# Prototype SDK support matrix

SDK availability depends on the system image, installed providers and account state.
Package or framework presence establishes a prerequisite, not successful SDK behavior.
The matrix records captured evidence only; it does not guarantee prototype runtime support.

## Support matrix

| Feature                                   | AOSP `default`                               | `google_apis` (AutoMobile default image) | `google_apis`, GMS disabled        | `google_apis_playstore`            | Physical Android                   | iOS Simulator (iOS 26/27)          | Physical iPhone                    |
| ----------------------------------------- | -------------------------------------------- | ---------------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- |
| MapLibre                                  | unverified                                   | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |
| Google Maps SDK                           | impossible (A: no GMS on API 30)             | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |
| MapKit                                    | unverified                                   | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |
| Android System WebView / WKWebView        | unverified                                   | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |
| Play Billing                              | unverified, needs account/hardware           | unverified, needs account/hardware       | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware |
| Google Pay TEST environment               | unverified, needs account/hardware           | unverified, needs account/hardware       | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware |
| Apple Pay sheet                           | unverified                                   | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware |
| StoreKit Testing                          | unverified, needs account/hardware           | unverified, needs account/hardware       | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware |
| Credential Manager                        | impossible (A: API 30 predates provider API) | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |
| Sign in with Apple                        | unverified, needs account/hardware           | unverified, needs account/hardware       | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware |
| Custom Tabs / ASWebAuthenticationSession  | impossible (A: no Custom Tabs service)       | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |
| ML Kit bundled models                     | unverified                                   | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |
| ML Kit unbundled models                   | unverified, needs account/hardware           | unverified, needs account/hardware       | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware | unverified, needs account/hardware |
| Apple Vision                              | unverified                                   | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |
| Glance / Quick Settings tiles / WidgetKit | unverified                                   | unverified                               | unverified                         | unverified                         | unverified, needs account/hardware | unverified                         | unverified, needs account/hardware |

`default` evidence is API 30 only (A); API 36 AOSP was not installed on the host.
The Google image columns are API 36 (B), with a separate disable probe (C).
The iOS column covers on-disk iOS 26.5/27.0 frameworks (D), not exercised SDK behavior.
All other `unverified` cells lack an SDK host-app run: this includes MapLibre,
MapKit, WebView rendering, Google Maps rendering, bundled ML Kit, Apple Vision,
widgets and tiles. No cross-platform implementation is inferred from an SDK name.
Account, purchase, model-download and physical-device checks were not exercised;
the account/hardware label does not imply compatibility on every platform.

## Captured prerequisites

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

## Provisioning

`ANDROID_TAG_PREFERENCE` in `src/devices/deviceProvisioning.ts` ranks
`google_apis` > `default` > `google_apis_playstore` when comparing images of equal
API level and ABI. The default preference therefore supplies GMS but does not
supply a working Play Billing service on the API 36 `google_apis` image. See
[device resources](device-resources.md) for `googlePlayServices` disabling.

Provisioning does not switch to `google_apis_playstore` for a session that wants
Play-dependent features. That image is a user build that refuses `adb root`, and
Play Billing on it still needs a signed-in Google account, which no captured image
has (evidence B). Choosing it automatically would give up root without making a
purchase flow work.

## Backend advertisement (#14302, contract only)

A spec picks an SDK backend only through its module's own `backend` field, such as
the map node's `backend` (#14308) or the commerce catalog's `backend` (#14314). It
never names an SDK or a URL. Runtimes advertise backends as capability strings, and
the report carries no separate backend field:

- The module's default backend (`auto` for maps, `fake` for commerce) needs only
  the module capability `prototype_platform_<module>_v1`. A module without a
  `backend` field, such as fake sign-in (`auth`, #14303), has only its default.
- Each other backend is one capability string,
  `prototype_platform_<module>_<backend>_v1`, for example
  `prototype_platform_map_google_v1` or `prototype_platform_commerce_storeKitTest_v1`.
  The backend name is spelled as in the spec's `backend` value.
- A runtime advertises a backend capability only while that backend can work on
  this device. Google Maps needs a host-configured key and GMS; Play Billing needs
  an image that serves `InAppBillingService.BIND`. A backend that becomes usable
  later appears in the next capability report. The spec does not change.
- The `platformModules` table in `schemas/prototype-spec-contract.json` lists each
  module's non-default backends and their capabilities next to its calls. The
  generated platform gates then refuse `show`, `patch` and `replaceNode` for a
  `backend` value whose capability is absent, with the field path, as they do for
  per-call capabilities. ProtoViewer `bundle.json` `requires` lists the same strings.

No module defines a non-default backend yet, so no gate exists. The module that
adds the first one adds its table entry and gate.
