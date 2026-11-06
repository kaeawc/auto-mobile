# ProtoViewer support

ProtoViewer (iOS and Android) opens, switches between and shares prototypes made with AutoMobile.
This page is the support page for the app's store listings.

## Get help

- **Report a problem or ask a question:** open an issue at
  [github.com/kaeawc/auto-mobile/issues](https://github.com/kaeawc/auto-mobile/issues). Include the
  app version (library settings), your device and OS version, and, if you can, the prototype that
  fails.
- **Security problems:** report them privately as described in the
  [security policy](https://github.com/kaeawc/auto-mobile/blob/main/SECURITY.md), not in a public
  issue.
- **Privacy:** see the [privacy policy](privacy.md).

## Common questions

**A prototype will not import.** ProtoViewer opens `.automobile-proto` bundles and prototype JSON
files. The import message names the part it refused, such as a missing image or a spec that needs a
newer ProtoViewer. Update the app, or re-export the prototype from AutoMobile.

**A prototype cannot reach the network.** Requests from imported prototypes are blocked until you
turn on **Allow network for imported prototypes** in the library settings. Loopback and link-local
addresses stay blocked even when it is on.

**Where are my prototypes stored?** Only on your device. Delete a prototype in the library to remove
it, or uninstall the app to remove everything.

**I installed a build I compiled myself.** Builds made from source install as a separate app
(`dev.jasonpearson.automobile.protoviewer.dev`) beside the store app, with their own library.
AutoMobile uses that build when both are installed.
