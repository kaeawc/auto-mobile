# ProtoViewer store policy fit

- Kind: concept
- Date: 2026-11-25
- Source: #14143
- Shaped: [ProtoViewer store listing as code](../how-it-works/protoviewer-store-listing.md)

## Context

ProtoViewer plays imported declarative prototypes and lets users share them. App Review and Google
Play review apps that run imported content closely. #14143 asked which store rules apply and what a
submission needs. The owner decided to ship sharing with report, block and contact first, and to
ship no bundled sample gallery; those decisions are in the
[ProtoViewer design record](2026-10-20-protoviewer-design.md). This entry records the current rule
text, read from official pages on 2026-11-25, and where ProtoViewer stands against each rule.

## App Store

The [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) were last
updated on October 16, 2026.

- **2.5.2.** Apps may not "download, install, or execute code which introduces or changes features
  or functionality of the app". The review position rests on this: a prototype is validated JSON
  read by a fixed renderer.
- **4.7.** The rule covers "HTML5 and JavaScript mini apps and mini games, streaming games, chatbots,
  and plug-ins". The November 13, 2025 revision added the HTML5 and JavaScript wording
  ([news](https://developer.apple.com/news/?id=ey6d8onl)). If a reviewer files prototypes under 4.7,
  4.7.1 to 4.7.5 apply. Those rules ask for filtering, reporting and blocking, no native APIs
  exposed "without prior permission from Apple", and per-instance consent before sharing data. They
  also ask for an index with universal links and age identification with an age restriction.
- **1.2.** Apps that let users "create, generate, upload, share, or otherwise contribute content"
  must include filtering, a report mechanism with "timely responses", blocking, and "published
  contact information". Developers who fail to remediate identified violations "may be considered
  in violation of the Developer Code of Conduct".
- **4.2.3.** "(i) Your app should work on its own without requiring installation of another app to
  function." A first launch shows an empty library, so the review notes carry an import demo.
- **2.1(a) and Before You Submit.** Reviewers need "full access to your app", including "a sample QR
  code" or similar resources. Attaching a sample `.automobile-proto` serves this.
- **2.3.1(a).** New features "must be described with specificity in the Notes for Review".
- **2.5.19**, added October 16, 2026: "Don't include any hidden, dormant, or undocumented features
  in your app" ([news](https://developer.apple.com/news/?id=92th7e5i)). The review notes should name
  every platform module a store build registers.

[App Review information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
notes hold up to 4000 bytes; the store-listing check enforces that limit.

**Age ratings.** The tiers are 4+, 9+, 13+, 16+ and 18+. Answers to the updated questions were due
by January 31, 2026 ([news](https://developer.apple.com/news/?id=ks775ehf)). Social media questions
are required from September 2026 ([news](https://developer.apple.com/news/?id=tlur8uvi)). The
Shared Location and Dating and Relationships descriptors must be declared by January 12, 2027
([news](https://developer.apple.com/news/?id=yxkh08us)). The
[definitions](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions)
list User-Generated Content and Messaging and Chat under 4+, Social Media under 13+, and Unrestricted
Web Access under 16+.

## Google Play

- **User Generated Content.** The
  [policy](https://support.google.com/googleplay/android-developer/answer/9876937) requires
  moderation that "requires users accept the app's terms of use and/or user policy before users can
  create or upload UGC". It also requires terms that define and prohibit objectionable content, and
  "an in-app system for reporting and blocking objectionable UGC and users". ProtoViewer has Report,
  Hide and Block, but no terms of use or acceptance step (#19269).
- **Device and Network Abuse.** An app "may not download executable code (such as dex, JAR, .so
  files) from a source other than Google Play". Code run by an interpreter, "such as JavaScript in a
  webview or browser", is exempt, but it "must not allow potential violations of Google Play
  policies" ([policy](https://support.google.com/googleplay/android-developer/answer/9888379)).
- **Reviewer access.** Play Console Requirements 3.3 asks for "an active demo account, login
  information, and all other resources needed". The
  [sign-in details page](https://support.google.com/googleplay/android-developer/answer/15748846)
  says to upload a QR code as a static URL. No page addresses an app whose content comes only from a
  user-supplied link, as ProtoViewer's does.
- **Content rating.** Developers answer the questionnaire in Play Console, and the UGC answers must
  be accurate ([Content Ratings](https://support.google.com/googleplay/android-developer/answer/9898843)).
  The help pages do not publish its question wording.

## Open items

The owner decisions and console steps left after this research are tracked in #19268, and the terms
acceptance gap in #19269.
