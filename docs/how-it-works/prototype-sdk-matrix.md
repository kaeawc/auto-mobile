# Prototype SDK support matrix

SDK availability depends on the system image, installed providers and account state. Package or
framework presence is a prerequisite, not working SDK behavior, and nothing here guarantees
prototype runtime support. No cross-platform implementation is inferred from an SDK name.

## Support matrix

Columns: AOSP `default` (API 30 only; API 36 AOSP not checked), `google_apis` (the AutoMobile
default image, API 36), `google_apis` with GMS disabled, `google_apis_playstore` (API 36),
physical Android, iOS Simulator (iOS 26.5/27.0 framework presence only) and physical iPhone.

No SDK has been run in a host app, so no cell is `verified`. Every physical-device cell is
"unverified, needs account/hardware".

| Feature                                                                                                                              | Status                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| MapLibre, MapKit, Android System WebView / WKWebView, ML Kit bundled models, Apple Vision, Glance / Quick Settings tiles / WidgetKit | unverified everywhere                                                                 |
| Google Maps SDK                                                                                                                      | impossible on AOSP `default` (no GMS on API 30); unverified elsewhere                 |
| Credential Manager                                                                                                                   | impossible on AOSP `default` (API 30 predates the provider API); unverified elsewhere |
| Custom Tabs / ASWebAuthenticationSession                                                                                             | impossible on AOSP `default` (no Custom Tabs service); unverified elsewhere           |
| Play Billing, Google Pay TEST environment, StoreKit Testing, Sign in with Apple, ML Kit unbundled models                             | unverified, needs account/hardware, on every runtime                                  |
| Apple Pay sheet                                                                                                                      | unverified on the Android columns; unverified, needs account/hardware, on iOS         |

Account, purchase, model-download and physical-device checks have not been run; the
account/hardware label does not imply compatibility on every platform. The image contents behind
these cells are recorded in
[SDK prerequisite captures](../devlog/2026-10-31-prototype-sdk-matrix-prerequisite-captures.md).

Image facts that affect setup:

- AOSP `default` API 30 has no GMS, Play Store, Chrome or Google WebView; its WebView provider is
  the non-updatable `com.android.webview`.
- Both API 36 Google images ship GMS and Maps packages, the updatable `com.google.android.webview`
  provider, and Chrome as the Custom Tabs service. Only `google_apis_playstore` serves
  `InAppBillingService.BIND`. Neither has a signed-in account, a Wallet package or NFC/HCE.
- `google_apis` is a userdebug build that allows `adb root`; the Play Store image is a user build.

## Provisioning

`ANDROID_TAG_PREFERENCE` in `src/devices/deviceProvisioning.ts` ranks
`google_apis` > `default` > `google_apis_playstore` when comparing images of equal
API level and ABI. The default preference therefore supplies GMS but does not
supply a working Play Billing service on the API 36 `google_apis` image. See
[device resources](device-resources.md) for `googlePlayServices` disabling.

A request that sets `requires.playStore: true` asks for Play-dependent features. It
matches only an emulator built from a Play Store system image (a `*playstore*` tag, or
Google TV), and a new emulator is created from `google_apis_playstore` (or the Play car
image for `automotive`). With no such image installed the request is refused with the
`sdkmanager` package to install. A device whose image is unknown, such as a physical
device, does not match. Without the requirement the preference above is unchanged.
Play Store images are user builds that refuse `adb root`, so root-dependent features on
them refuse with a message that they need a non-Play image. Play Billing there still
needs a signed-in Google account, which no captured image has.

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

The `map` module lists `google` and `maplibre` (#14309). The TypeScript gates are
generated from the table; the Kotlin and Swift strict scanners read the same table
for the node that carries `backend`.

## Background

- [SDK prerequisite captures](../devlog/2026-10-31-prototype-sdk-matrix-prerequisite-captures.md)
