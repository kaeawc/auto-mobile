# Wear OS tiles and watch faces

`wearSurface` manages tiles, watch faces and complications on a [Wear OS emulator](wear-os.md).
Enable it with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)). Like `ambient`, it
refuses any device not confirmed to be a watch and changes nothing.

## Tiles

Call `listTileProviders` with no other argument to get the installed tile providers. Then pass one
provider's `component` (`<package>/<service>`) to a tile action:

```json
{
  "name": "wearSurface",
  "arguments": {
    "action": "showTile",
    "component": "com.google.android.contacts/com.google.android.wearable.contacts.tiles.FavoriteContactsTileService"
  }
}
```

| `action`            | Arguments              | `success: true` means                                                                 |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `listTileProviders` | none                   | `providers` lists the installed tile providers (it may be empty)                      |
| `addTile`           | `component`            | The tile is in the carousel at `index` (it may already have been there)               |
| `removeTile`        | `component`            | The tile was removed or was not there; the watch does not say which                   |
| `showTile`          | `component` or `index` | An observe after a 3 s settle shows a tile container in the foreground Wear system UI |

The watch reports success for an `index` with no tile and for removing an absent tile. Only
`showTile` checks the screen. Its `verified: true` means AutoMobile saw a tile container in the
foreground Wear system UI. `addTile` and `removeTile` always return `verified: false`.

| Result field      | Content                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requested`       | The request as sent                                                                                                                                                      |
| `broadcastResult` | `code`, `data` and a typed `outcome`: `added`, `removed`, `showRequested`, `providerNotFound`, `missingComponent`, `indexRequired`, `unrecognizedOperation` or `unknown` |
| `index`           | The tile's index, when known                                                                                                                                             |
| `reason`          | Why the action failed                                                                                                                                                    |

- Indexes shift: AutoMobile inserts a new tile at index 0, which pushes the others along. Prefer
  `showTile` with `component`, which looks up the current index right before showing. That lookup
  adds the tile when it is missing; `indexResolution` holds its reply.
- `showTile` succeeds when any tile is visible, including a tile already on screen. A watch face
  alone cannot verify a tile, even if its clock changes. Verification confirms a visible tile, not
  its identity or requested index.
- Use `observe` to read the tile's content and `swipeOn` left or right to move through the carousel.
- Each `providers` entry has `component` (pass it as `component`), `packageName` and `className`.
- `addTile`, and `showTile` with `component`, first check the component against the installed
  tile providers. An unknown component fails with an error naming the valid components, and
  AutoMobile sends nothing. The `.Service` short form of a listed provider also works.
- `providerNotFound` in `broadcastResult` means the watch refused a listed provider, for example
  one disabled since the check. Run `listTileProviders` again.
- `unrecognizedOperation` means this Wear OS build does not accept the debug broadcasts.
- The tool is unverified on a physical device, so check `broadcastResult` when a result surprises you.

## Read the watch faces

`wearSurface` with `"action": "watchFace"` (no other arguments) reads the watch faces without
changing anything:

```json
{
  "success": true,
  "action": "watchFace",
  "available": true,
  "activeFace": { "package": "com.google.wear.offhand", "favoriteId": 1, "fallback": false },
  "favorites": [
    {
      "favoriteId": 1,
      "package": "com.google.wear.offhand",
      "slots": [
        { "slot": 11, "type": 1, "provider": null },
        {
          "slot": 12,
          "type": 3,
          "provider": "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.DayAndDateProviderService"
        }
      ]
    }
  ],
  "ambient": false,
  "message": "Active watch face com.google.wear.offhand (favorite 1); 1 favorite(s)."
}
```

- `activeFace.fallback: true` means the classic fallback face, which has no complication slots.
- `favorites` lists every saved favorite. Each slot has its `slot` id, complication data `type`
  and `provider` (`<package>/<class>`, or `null` when the slot is empty). The active favorite's
  slots are the live configuration; the other favorites show their saved slots.
- `ambient` is the watch face's own ambient flag, the same reading the `ambient` tool uses. It is
  absent when the watch does not report it.
- `available: false` (with `success: false` and a `reason`) means the watch reported no readable
  watch faces; nothing is thrown. A failed adb command returns an error instead.
- `watchFace` does not render a preview. Use `observe` or a screenshot to see the face.

## Set watch faces and complications

Name a resource-only (Watch Face Format) face by its bare package (`com.google.wear.offhand`) and a
classic face as `<package>/<class>`. Never pass `<package>/_placeholder_`. Complication types are
the androidx type ints (`SHORT_TEXT` = 3, `RANGED_VALUE` = 5). The `provider` is the data source
service as `<package>/<service>`.

```json
{
  "name": "wearSurface",
  "arguments": {
    "action": "setComplication",
    "watchFace": "com.google.wear.offhand",
    "slot": 11,
    "type": 5,
    "provider": "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.BatteryProviderService"
  }
}
```

| `action`            | Arguments                               | `success: true` means                                     |
| ------------------- | --------------------------------------- | --------------------------------------------------------- |
| `setWatchFace`      | `watchFace`                             | The face is the active one, with the reply's favorite id  |
| `unsetWatchFace`    | none                                    | The face active before `setWatchFace` is active again     |
| `setComplication`   | `watchFace`, `slot`, `type`, `provider` | The active face's slot shows that provider with that type |
| `unsetComplication` | `watchFace`, `slot`, `provider`         | The active face's slot is empty                           |

The watch accepts a request before applying it. Each action therefore reads `dumpsys wear_service`
back for up to about 5 s. It sets `applied: true` (and `verified: true`) only when the change shows
there.

| Result field      | Content                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requested`       | The request as sent                                                                                                                                                                     |
| `broadcastResult` | `code`, `data`, `accepted`, `favoriteId`                                                                                                                                                |
| `favoriteId`      | The favorite the watch used                                                                                                                                                             |
| `readback`        | The last readback: `activeFace`, `favorites` and `ambient`, as `watchFace` reports them                                                                                                 |
| `error`, `reason` | A typed error and its explanation, on failure                                                                                                                                           |
| `change`          | `setComplication`/`unsetComplication` only: `unchanged` when the slot already showed the request, `applied` when the broadcast changed it, absent when the slot could not be read first |

| `error`                   | Meaning and what to do                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_not_found`      | `provider` is not a complication data source on the device; nothing was sent. `reason` names the installed ones                                   |
| `unsupported_type`        | Accepted but ignored: the slot kept its previous provider and type, so the provider does not support `type`. Pass a type the data source declares |
| `not_applied`             | Accepted but the slot does not show the request (and changed to something else), or the readback was unreadable                                   |
| `face_not_installed`      | No such face package (or class): check the name                                                                                                   |
| `slot_out_of_range`       | The face has no such slot, or it is not the active face: `setWatchFace` first                                                                     |
| `invalid_face_id`         | A `_placeholder_` class: pass a resource-only face as its bare package                                                                            |
| `unsupported_face`        | The fallback face has no slots: set another face first                                                                                            |
| `debug_surface_disabled`  | The debug receiver is off on this build: enable developer options and retry                                                                       |
| `watch_face_not_switched` | `unsetWatchFace` with nothing to revert                                                                                                           |
| `missing_argument`        | The watch rejected the extras it was sent                                                                                                         |
| `unknown_reply`           | A reply this release does not know: check `broadcastResult`                                                                                       |

- Slots belong to the active face, so set the face before its complications. List its slot ids
  with `watchFace` (the active favorite's `slots`).
- `setComplication` checks `provider` against the device's complication data sources before
  sending. It cannot check `type` first, because the device does not list each source's supported
  types. An unsupported type comes back as `unsupported_type` after the readback.
- The tool is unverified on a physical device.
