# Prototype SDK vendor prerequisites

- Kind: concept
- Date: 2026-11-25
- Source: #14302
- Shaped: [Prototype SDK support matrix](../how-it-works/prototype-sdk-matrix.md)

## Context

The SDK support matrix records which system images carry each SDK's packages. It did not record
what each vendor says the SDK needs at run time, or whether the vendor documents emulator or
Simulator support. This entry records those vendor statements, read on 2026-11-25.

A tag marks each claim's source: [A] official vendor documentation or reference, [B] a vendor staff
forum reply or a vendor-maintained sample, codelab or lint page, [C] a non-staff post. "Not stated"
means no primary page says it. No SDK ran on a device for this entry, so no matrix cell changes.

## Android

- **Google Maps SDK.** "Maps SDK for Android requires that the device on which you deploy your app
  has the Google Play services installed." An emulator must be "based on Android 6.0 or higher and
  includes the Google APIs". Calls "require API calls to include an API key" from a Cloud project
  with billing enabled. [A]
  <https://developers.google.com/maps/documentation/android-sdk/config>,
  <https://developers.google.com/maps/documentation/android-sdk/get-api-key>
- **MapLibre Native.** A Maven Central dependency. The getting-started example uses the public
  `demotiles.maplibre.org` style with no API key. Google Play services are not mentioned. [A]
  <https://maplibre.org/maplibre-native/android/examples/getting-started/>
- **Play Billing.** "The Google Play Billing Library is blocked for apps that aren't signed and
  uploaded to Google Play. License testers can bypass this check". The package must match the Play
  app, the active account must be a license tester, and "the most current version of the Google
  Play application must be installed". The page names hardware devices only; an emulator statement
  is not stated. [A] <https://developer.android.com/google/play/billing/test>,
  <https://support.google.com/googleplay/android-developer/answer/6062777>
- **Google Pay API, TEST.** Needs `play-services-wallet` 20.0.0 and minSdk 23, and the troubleshooting
  page says the API "requires Google Play services library version 8.4+". [A]
  <https://developers.google.com/pay/api/android/guides/setup>,
  <https://developers.google.com/pay/api/android/support/troubleshooting>
  Two official pages disagree on cards. The sample-tokens page says "you must add at least one
  chargeable card to your Google Account". The test card suite page says it works "without the need
  to add an actual credit card". [A]
  <https://developers.google.com/pay/api/android/guides/resources/sample-tokens>,
  <https://developers.google.com/pay/api/android/guides/resources/test-card-suite>.
  The codelab asks for "an Android-powered device or emulator with the latest version of Google Play
  services". [B] <https://codelabs.developers.google.com/pay-android-checkout>
- **Credential Manager.** Passkeys target "Android 9 (API level 28) or higher" and are created after
  screen-lock verification. [A]
  <https://developer.android.com/identity/passkeys/create-passkeys>
  `credentials-play-services-auth` "is required for Android 13 and below". [B]
  <https://googlesamples.github.io/android-custom-lint-rules/checks/CredentialDependency.md.html>
  For Sign in with Google, "if no Google Accounts exist on the device, the bottom sheet UI does not
  appear". [A] <https://developer.android.com/identity/sign-in/credential-manager-siwg>
- **Custom Tabs.** "Custom Tabs are supported by most Android browsers." With no supporting browser,
  the intent opens the default browser instead. [A]
  <https://developer.chrome.com/docs/android/custom-tabs/guide-get-started>
- **ML Kit.** Unbundled models are "downloaded and managed via Google Play Services". The build links
  bundled models into the app. Digital Ink, Translation and Entity Extraction download their models
  on demand into app storage; no page says whether they need Google Play services. [A]
  <https://developers.google.com/ml-kit/tips/installation-paths>
- **WebView.** WebView has been an updatable system component since Lollipop. On Android 10 and
  later, AOSP images use `com.android.webview` and GMS images use `com.google.android.webview`. The
  AOSP prebuilt "is not currently updated on a regular schedule". [A]
  <https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/webview-providers.md>,
  <https://developer.android.com/develop/ui/views/layout/webapps/managing-webview>
- **Glance and Quick Settings tiles.** Glance's default minSdk moved from API 21 to API 23, and Glance
  "requires Compose to be enabled". `TileService` was added in API 24; `requestAddTileService()` in
  API 33. Neither page mentions Google Play services or emulators. [A]
  <https://developer.android.com/jetpack/androidx/releases/glance>,
  <https://developer.android.com/reference/android/service/quicksettings/TileService>

## iOS

- **MapKit.** The native framework needs no API key; keys are for MapKit JS and the Maps Server API.
  Without the paid program "you can use the MapKit framework but you can't provide routing
  directions". Simulator support is not stated. [A]
  <https://developer.apple.com/help/account/reference/supported-capabilities-ios/>
- **WKWebView.** Apple ships WebKit with each OS release ("Safari 26 is available for iOS 26").
  That WKWebView cannot update apart from iOS is an inference; no page states it. [A]
  <https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes>
- **Apple Pay.** Needs a merchant identifier and the Apple Pay capability, which the paid program
  provides. [A] <https://developer.apple.com/documentation/passkit/setting-up-apple-pay>
  "Running in Simulator doesn't require a card." [B]
  <https://developer.apple.com/documentation/passkit/offering-apple-pay-in-your-app>.
  The sandbox needs an App Store Connect sandbox tester and describes iPhone, iPad and Apple Watch
  use only. [A] <https://developer.apple.com/apple-pay/sandbox-testing/>
- **StoreKit Testing.** "You can test your app in Simulator or on real devices", with no App Store
  Connect setup. Xcode signs the transactions. [A]
  <https://developer.apple.com/documentation/storekit/testing-at-all-stages-of-development-with-xcode-and-the-sandbox>.
  iOS 26.6 fixed this defect: "SKTestSessions does not properly connect to the test environment when
  using Simulator". Earlier 26.x runtimes still have it. [A]
  <https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-26_6-release-notes>.
  Two iOS 27.0 `SKTestSession` known issues are fixed in iOS 27.2. [A]
  <https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27_2-release-notes>
- **Sign in with Apple.** Needs the `com.apple.developer.applesignin` entitlement, from the paid
  program. [A]
  <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.applesignin>
  The run destination must be signed in to an Apple Account with two-factor authentication. [B]
  <https://developer.apple.com/documentation/authenticationservices/implementing-user-authentication-with-sign-in-with-apple>.
  A DTS engineer reported an iOS 18 Simulator regression with the workaround "use a physical
  device"; a fix on later runtimes is not stated. [B] <https://developer.apple.com/forums/thread/769231>
- **Vision.** Apple staff say the Neural Engine "is not supported in the Simulator", and
  `VNGenerateForegroundInstanceMaskRequest` "is not supported on CPU and will therefore not run in
  the simulator". [B] <https://developer.apple.com/forums/thread/696714>,
  <https://developer.apple.com/forums/thread/764948>
- **WidgetKit.** Needs a widget extension target. Running the extension shows the widget "on
  iPhone, on the Home Screen"; an explicit Simulator statement is not stated. [A]
  <https://developer.apple.com/documentation/widgetkit/debugging-widgets>
- **ASWebAuthenticationSession.** iOS 12 and later. HTTPS callbacks need iOS 17.4 and an associated
  domain; custom-scheme callbacks need no entitlement. Simulator support is not stated. [A]
  <https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession>

## Open checks

Each "not stated" above, and every matrix cell, still needs a device or Simulator run. The open
runs are tracked in #19267.
