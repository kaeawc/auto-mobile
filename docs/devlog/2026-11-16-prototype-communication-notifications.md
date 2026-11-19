# Communication-style notifications for prototypes

- Kind: idea
- Date: 2026-11-16
- Source: #14278 (part of #14174)
- Shaped: [Prototype platform services](../how-it-works/plat/android/prototype-ux-platform-services.md)

## Context

A messaging prototype such as a chat app looks wrong unless the OS gives its notifications
conversation treatment. The `messaging` style of `notifications.post` (#14280) renders a plain
`MessagingStyle` on Android and a plain banner on iOS. It has no conversation, avatar or bubble.

This entry records the platform requirements, the feasibility of each item, and a spec sketch. The
requirements come from the platform documentation. Every row marked "pending device check" still
needs an emulator or simulator run before an implementation issue is filed. The disposable app shell
(#14184) and the two notification runtimes (#14281, #14282) block those runs.

## Platform requirements

**Android 11 (API 30) and later.** A notification appears in the Conversations section only when all
of these hold:

- it uses `MessagingStyle` with a `Person` for each sender;
- it calls `setShortcutId` with the id of a long-lived sharing shortcut, which is pushed with
  `ShortcutManagerCompat.pushDynamicShortcut`, `setLongLived(true)` and `setPerson`;
- the posting package owns that shortcut.

`setLocusId` links the notification to the conversation's screen in the app. Without it, ranking
and dismissal sync still work.

A bubble also needs `BubbleMetadata` with an Activity that is resizeable, `allowEmbedded="true"` and
`documentLaunchMode="always"`. Bubbles must be allowed at three levels: the device setting
(`Settings.Secure` `notification_bubbles`), the app preference, and the channel or conversation.

**iOS 15 and later.** A communication notification shows the sender avatar and can break through a
Focus only when all of these hold:

- the app has the `com.apple.developer.usernotifications.communication` entitlement;
- `Info.plist` lists `INSendMessageIntent` in `NSUserActivityTypes`;
- the app donates an `INInteraction` for an `INSendMessageIntent` whose sender `INPerson` carries an
  `INImage`;
- the content is replaced with `UNNotificationContent.updating(from:)` before delivery.

A local notification can do this in the app process. A remote push, including `simctl push`, needs a
Notification Service Extension and `mutable-content: 1`.

## Feasibility

| Item                                                   | Runtime              | Status                                                                                                                                                 |
| ------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversations section on Android                       | Disposable app only  | Feasible by the docs; pending device check on API 33 and 36                                                                                            |
| Conversations section from CtrlProxy                   | CtrlProxy overlay    | Not feasible: the shortcut must belong to the posting package, and one shortcut set per prototype would collide                                        |
| Bubbles on Android                                     | Disposable app only  | Feasible by the docs; pending device check                                                                                                             |
| Deterministic bubble enablement                        | adb                  | Candidates are `settings put secure notification_bubbles 1` plus `cmd notification set_bubbles <pkg> <uid> 1`; pending device check on both API levels |
| Shortcut cleanup on uninstall                          | Disposable app       | Dynamic and cached shortcuts go with the package by the docs; pending device check                                                                     |
| Coexistence with direct-share shortcuts (#14235)       | Disposable app       | Expected to work: one shortcut can carry both the share target category and `setLongLived(true)`; pending device check, and needs #14235's id scheme   |
| Communication entitlement with ad-hoc signing          | iOS simulator Viewer | Unknown; pending simulator check. The simulator does not check provisioning, so an embedded entitlement may be enough                                  |
| Avatar from `updating(from:)` for a local notification | iOS simulator Viewer | Feasible if the entitlement holds; pending simulator check                                                                                             |
| Avatar for `simctl push`                               | iOS simulator Viewer | Needs a Notification Service Extension in the Viewer; pending simulator check                                                                          |
| Focus breakthrough on simulator                        | iOS simulator        | Unknown; Focus is hard to drive on a simulator, so this may be documented as untestable                                                                |

## Spec sketch

Extend the existing `messaging` style object rather than adding a new discriminator. The style is
`type: "messaging"`, with `self`, `conversationTitle` and `messages`. The new optional fields are:

- `conversationId`: a key-shaped id. It names the Android shortcut and locus id, and the iOS
  conversation identifier. Two posts with the same id belong to one conversation.
- `avatars`: a map from a sender name (a `from` value, or `self`) to an asset id.
- `important`: a boolean that marks the conversation as priority on Android. It has no iOS effect.
- `bubble`: a boolean, Android only. It needs `conversationId`.

These fields need the disposable app runtime. On any other runtime, `post` would still show the
plain `messaging` style and report that conversation treatment was not applied. It would not fail,
so a spec runs unchanged in every runtime. The exact result field is left to the implementation
issue.

## Proposed follow-ups

1. Device spike on API 33 and 36 emulators in the disposable app: Conversations placement, bubbles,
   the two adb enablement commands, uninstall cleanup and #14235 coexistence. Record versions and
   describe the screenshots in text.
2. Simulator spike in the Viewer: ad-hoc entitlement, `updating(from:)` with a local notification,
   and a Notification Service Extension for `simctl push`.
3. Spec: add `conversationId`, `avatars`, `important` and `bubble` to the `messaging` style in
   `schemas/prototype-spec-contract.json`, plus the non-applied result for other runtimes.
4. Android runtime: shortcut push, `Person` icons from assets, `BubbleMetadata` and a bubble
   Activity in the disposable app shell.
5. iOS runtime: intent donation and `updating(from:)` in the Viewer, gated on the result of step 2.
