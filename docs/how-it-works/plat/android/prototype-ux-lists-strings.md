# Prototype spec: lazy lists and strings

Part of [the agent-authored prototype specification](prototype-ux.md).

## Lazy lists (`prototype_lazy_list_v1`, #14182)

A `list` is its own scrolling container. Its row template is composed lazily in data order;
only composed rows appear in `observe`. Use `swipeOn` on the list to reach later rows. The
container preserves authored `testTag` / `contentDescription` and exposes a scrollable collection
to accessibility (Android LazyColumn/LazyRow collection info and scroll actions; iOS ScrollView).
The list node, `request.append` and `prependData` require `prototype_lazy_list_v1` together with
`prototype_data_model_v1`.

| Field                          | Contract                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repeat`                       | Required `{items:{path}, as, key}`; path resolves relative to `data` to an array of objects. Literal items are forbidden.                                                                                |
| `children`                     | Exactly one row template; `{index}`, `{<as>.<field>}`, state/data bindings and ordinary repeat projection rules apply.                                                                                   |
| `axis`                         | `vertical` (default) or `horizontal`.                                                                                                                                                                    |
| `header`, `footer`             | Optional single ordinary nodes inside the scrolling content, outside the row repeat scope.                                                                                                               |
| `spacing`, `contentPadding`    | Nonnegative dp; gap between rows/header/footer and padding inside the scroll bounds.                                                                                                                     |
| `onEndReached`, `endThreshold` | Ordinary action list; threshold 1–50 (default 3), permitted only with `onEndReached`.                                                                                                                    |
| `refresh`                      | `{stateKey,onRefresh}` as on scroll: declared boolean state key, set true before actions run. Vertical lists only; also needs `prototype_refresh_v1`.                                                    |
| `maxItems`                     | Optional integer 1–`MAX_PROTOTYPE_LIST_ITEMS`, greater than `endThreshold` (default 3) when `onEndReached` is set. Initial data must fit. Appends trim the oldest rows from the start in the same write. |

`repeat.key` must name a projected scalar field present in every item, with unique rendered
values. Keys preserve row identity across appends, trims and reorders. Empty lists and several
independent lists in one spec are valid. Lists cannot appear inside another list or a repeat
template, including expanded components. A list and an ancestor/descendant scroll cannot share
an axis; cross-axis scrolling is allowed. The row template cannot contain another repeat or pager
(the existing repeat-template restrictions apply).

The row template counts once against node/image limits, even for zero rows; header/footer count
once each. Per-item field, state-key, action, substitution and repeat-path-cell budgets still
apply. List paths accept up to `MAX_PROTOTYPE_LIST_ITEMS` (2000), with overflow reported at
`<list>.repeat.items.path` as `Repeat path resolves to more than 2000 items`. A source longer than
`maxItems` fails there with `List data has more items than maxItems`. Ordinary repeats keep their
128-item cap and count expanded instances.

The edge trigger is per list path and resets on a new show. It fires for a nonempty list when
`lastVisibleIndex >= rowCount - endThreshold`, once per `(rowCount,lastRowKey)` signature.
Recomposition preserves the signature. A page adding no rows does not retrigger; a sliding
`maxItems` window can retrigger at unchanged length when its final key changes. A list fitting
on screen fires once and again as new pages arrive to fill the viewport. It runs ordinary actions
without an extra interaction event. Header/footer do not contribute to row counts.

`request.append:{from,to}` reads an array at the RFC 6901 `from` pointer in the JSON response,
removes that object member from the remaining response, and extends the existing array at the
`/data/...` target `to`. The `from` pointer must have an object parent, not an array parent. Optional `into`
receives the remaining response and must not overlap `to` in either direction. A literal `to`
that already resolves to a non-array is invalid; whole `{index}` segments follow `into` rules
inside repeats. Response validation, extend, `into` and metadata writes are atomic: a missing or
non-array source/target, unsupported parent or data-limit failure rolls everything back and
reports `invalid_response`. The result reports `appended`, the number of response rows added.

`appendData`, `prependData` and request append use the smallest `maxItems` among lists whose exact data
path matches the write target. The shared writer supports `append` (one value), `extend` (array values) and `prepend` (array values), with optional `maxItems`. Append/extend trim from the start and prepend trims from the end before checking final
array/byte/depth limits. The writer reports `trimmed` (0 when none). Without a cap, the ordinary
`MAX_PROTOTYPE_DATA_ARRAY_ITEMS` limit applies after concatenation. `extend` rejects a non-array value with
`invalid_value`, a missing target with `not_found`, and a non-array target with `not_array`.

A device change event names the target `/data/...` path and carries
`{op:"append"|"extend"|"prepend",value,maxItems?,revision}`. The host replays it through the same writer;
malformed extend/prepend values or noninteger/nonpositive `maxItems` are dropped. A page too large for the
emit byte budget travels without `value`; the host then stops tracking the spec instead of mirroring
it. Request success emits the extend event first, then `into`, `into__meta`, status key,
`prototype_request` and `onSuccess`.

`prependData {path,value}` resolves one binding value `v` and writes `{op:"prepend",path,value:[v],maxItems?}`.
The writer preserves page order (`value ++ existing`) and keeps the first `maxItems` rows, even
when the page alone exceeds the cap. Empty pages still trim existing rows. Its errors parallel
`extend`, with messages naming `prependData`; trimming precedes final limits. It requires
`prototype_lazy_list_v1`, `prototype_data_actions_v1` and `prototype_data_model_v1`.

Renderers retain the first visible row's key and on-screen offset across row changes, including
at the top; headers and footers are not anchors. Prepended rows stay above the viewport until the
user scrolls up. If the key was trimmed, the renderer default applies. Each stack entry retains
its list anchor (row key and offset) while covered by a push and restores it on pop; a missing row
falls back to the nearest surviving index or top.

A newer request cancels an in-flight one whose `into` or `append.to` equals, contains or sits inside
the newer request's `into` or `append.to` (latest wins). A refresh that replaces `/data/feed` and
a page append to `/data/feed/items` therefore cannot interleave. A failed page request does not re-arm the
trigger; the signature changes again only when the data does (a refresh, for example). A device data
write that would leave a list's array with a non-object row, a missing, non-scalar or duplicate
`repeat.key`, or more than `maxItems` rows is refused (`invalid_value`) and changes nothing.

```json
{
  "id": "feed",
  "window": {
    "placement": {
      "type": "fullscreen"
    }
  },
  "data": {
    "feed": {
      "items": [
        {
          "id": 1,
          "title": "One"
        },
        {
          "id": 2,
          "title": "Two"
        }
      ]
    },
    "page": {
      "next": "p2"
    }
  },
  "state": {
    "refreshing": false,
    "feedStatus": "idle"
  },
  "root": {
    "type": "list",
    "repeat": {
      "items": {
        "path": "/feed/items"
      },
      "as": "post",
      "key": "id"
    },
    "children": [
      {
        "type": "text",
        "text": "{index}: {post.title}"
      }
    ],
    "id": "feed-list",
    "header": {
      "type": "text",
      "text": "Feed"
    },
    "footer": {
      "type": "text",
      "text": "End"
    },
    "spacing": 8,
    "contentPadding": 12,
    "endThreshold": 2,
    "maxItems": 100,
    "onEndReached": [
      {
        "type": "request",
        "url": "http://localhost:8080/feed?after={data:/page/next}",
        "into": "/data/page",
        "append": {
          "from": "/items",
          "to": "/data/feed/items"
        },
        "statusKey": "feedStatus"
      }
    ],
    "refresh": {
      "stateKey": "refreshing",
      "onRefresh": [
        {
          "type": "request",
          "url": "http://localhost:8080/feed",
          "into": "/data/feed",
          "onSuccess": [
            {
              "type": "setState",
              "key": "refreshing",
              "value": false
            }
          ]
        }
      ]
    }
  }
}
```

### Timers

`onAppear` requires `prototype_timers_v1`: 1..32 ordinary actions on the root or a node
with `visibleWhen`, rejected at `<path>.onAppear` elsewhere. First show and reset show run
initially visible handlers; later hidden-to-visible edges run them again. A state-preserving
same-id show seeds visibility without firing, and visible-to-visible updates do nothing.
Effective visibility includes ancestors and the active pager/stack child. Repeat instances bind
handlers like taps and keep separate path identities. Each handler is one validated atomic
interaction with tap change-event rules and no idle-TTL activity. Cascades stop at the action-depth
limit; a handler cannot run twice within an interaction. Node hiding does not cancel its timers.

`startTimer {id, afterMs, everyMs?, maxRuns?, actions}` and `cancelTimer {id}` require
`prototype_timers_v1`. IDs are literal strings of 1..64 characters and never repeat-bound.
Delays are integers 100..3600000 ms; maxRuns is 1..10000 total fires including the first and
requires everyMs. A list contains 1..32 actions and shares the request follow-up depth limit.
The whole spec, including components and platform handlers, may declare eight distinct timer ids.

Each prototype has a ledger of at most eight live timers. Starting a live id replaces it and resets
runs. Cancelling an unknown id is a no-op. Each fire uses the same atomic interaction as a tap:
requireValid and all planned writes are validated together; rejection drops state changes and events
but counts the run. One change event follows a net state change. Dismiss cancels every timer.
A timer may cancel itself; replacing its own id during a fire wins over the old timer's reschedule.
Repeats advance from the planned fire time, without drift, until maxRuns or cancellation.
Fires never restart idle TTL. Hidden/inactive prototypes freeze remaining time and restore it on
resume; transient screenshot hides do not pause. Dismiss (including TTL, disconnect or teardown)
and replacing show cancel timers; patch preserves them.

The injected clock/scheduler drives real scheduling. `prototype {action:"simulate",id,advanceTimeMs}`
advances 1..3600000 ms without waiting and returns optional `fired`, refusing before sending unless
the capability is advertised. The `advance_prototype_clock {id,advanceTimeMs}` tool fires due timers in
chronological order, ties by start order, including newly started timers due in the window.
Paused advancement fires zero times. Exactly 10000 due fires succeed; if an additional fire is
still due, advancement stops at the last fire with an error and fired=10000, retaining pending timers
for the next call. Real scheduling continues from shifted time. Inspect reports `timers:[{id,nextFireInMs,runs}]` sorted by remaining
time then start order, with nonnegative remaining time frozen while paused. Devices omit the field
when empty; the host returns an array for capable devices, including an empty array when absent,
and omits malformed timer reports.

Cross-field errors point to `.maxRuns` when everyMs is absent and to `.id` on the ninth distinct
startTimer in contract document order. A cancelTimer id with no declaration produces a host-only
show/patch warning. This asymmetry is deliberate: Kotlin and Swift accept it without a diagnostic
and cancellation remains a runtime no-op.

## Strings and semantics (#14210)

`prototype_strings_v1` gates top-level `strings` and every `{t:` display placeholder;
`prototype_semantics_v1` gates every node's `semantics`. Unsupported fields refuse show/patch
before rendering. Host validation and the shared contract define the accepted shape.

```json
{
  "strings": {
    "default": { "cart.title": "Cart", "cart.items": { "one": "{#} item", "other": "{#} items" } },
    "fr": {
      "cart.title": "Panier",
      "cart.items": { "one": "{#} article", "other": "{#} articles" }
    }
  },
  "root": { "type": "text", "text": "{t:cart.title}", "semantics": { "heading": true } }
}
```

The fragment shows the strings/root portion of an envelope. `default` is mandatory. Up to 16 tables,
512 keys per table and 2048 characters per nonempty string/form are accepted. Locale tags match
`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`; keys match `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`.
Normalized duplicate tags are rejected. Plurals accept only zero/one/two/few/many/other, with other
required. Values may contain `{key}` state bindings and plural `{#}`, but cannot contain `{t:`,
`{data:` or `{platform:`. String tables are opaque to all other binding and node walkers.

Display fields (including spans and semantics.label/hint) accept `{t:key}` and `{t:key|count}`;
contentDescription instead directs authors to semantics.label. Every reference must exist in default;
plural default entries require a count. Counts are non-negative integer literals of 1–9 digits or
`{data:/pointer}`; state-key counts are unsupported. Missing, negative, fractional or non-number
runtime counts select other. Resolution order is data substitution, translation, then state binding.
Translated text is never scanned again for translations. `{#}` becomes decimal count without grouping.

Show `locale` is optional, show-only, at most 35 characters and uses the locale-tag pattern above.
It is forwarded as a top-level `locale` string in `show_prototype` only for specs with strings.
Each show states it afresh. Otherwise the current device preferred locale list is used; configuration
changes on Android and locale notifications/trait changes on iOS re-resolve live without the host.
Expand each requested tag to its full tag then shorter prefixes (`zh-Hant-TW`, `zh-Hant`, `zh`),
deduplicate, and finally try default. Matching ignores case and treats `_` as `-`. Lookup falls back
per key. The supplying table's language selects the plural category; default uses the first requested
language, or en. Missing selected forms use other; a missing runtime key renders its key text.

| Languages                                                                   | Integer category rule                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ja zh ko vi th id ms lo km my                                               | other                                                                                        |
| en de nl sv da nb no fi it es el hu tr bg ca et eu sw ur; unknown languages | one when n=1, otherwise other                                                                |
| fr pt hi bn fa gu kn am                                                     | one when n=0 or 1, otherwise other                                                           |
| ru uk be                                                                    | one when n%10=1 and n%100!=11; few when n%10=2..4 and n%100 not 12..14; otherwise many       |
| pl                                                                          | one when n=1; few when n%10=2..4 and n%100 not 12..14; otherwise many                        |
| cs sk                                                                       | one when n=1; few when n=2..4; otherwise other                                               |
| ar                                                                          | zero at 0, one at 1, two at 2; few when n%100=3..10; many when n%100=11..99; otherwise other |

Hand-written rules are shared across platforms and cross-checked against Intl.PluralRules fixtures
for 0..120, 1000, 1001, 1002, 1011 and 1012. Romance many for million multiples (fr/pt/es/it) is
intentionally ignored. Non-integers use other. With explicit show locale, platformNotes
`strings.fallback` uses platform all and lists the locale plus up to 20 referenced keys reaching
default (`values`, with `paths` into strings.default and `total` only when capped). Without an
override the host does not know device locales. PseudoLocale accents/pads/brackets every table
value/form, preserving locale tags, keys, plural category names and bindings. Node `{t:...}` remains
intact; semantics.label/hint are display fields, contentDescription remains unchanged.

Every node accepts `semantics` with at least one of heading (boolean), liveRegion (polite/assertive),
group (boolean), nonempty label/hint, or unique traits (1–3 of button/image/selected). Label and
contentDescription on the same node conflict; label/hint accept translation/data/state placeholders.
A liveRegion without text descendants is valid.

| Semantics                    | Android Compose                                                       | iOS SwiftUI                                                                                               |
| ---------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| heading                      | heading()                                                             | isHeader trait                                                                                            |
| liveRegion                   | LiveRegionMode.Polite/Assertive                                       | Accessible-text changes post announcements, excluding initial render; assertive uses high speech priority |
| group                        | isTraversalGroup=true                                                 | accessibilityElement(children: .contain)                                                                  |
| label                        | contentDescription                                                    | accessibilityLabel                                                                                        |
| hint                         | onClickLabel for a tap action, otherwise appended to stateDescription | accessibilityHint                                                                                         |
| button/image/selected traits | Role.Button / Role.Image / selected=true; PrototypeRole retained      | isButton / isImage / isSelected                                                                           |

Semantics-bearing nodes bypass decorative/container skips. Android observe exposes `heading` as
string `"true"` (API 28+) alongside `live-region` strings polite/assertive. The iOS XCUITest snapshot
path exposes no SwiftUI traits; observe cannot verify those semantics today. Advisory lint adds
missing-translation (missing key, shape mismatch or missing required integer plural form),
unknown-translation-key (locale key absent from default), and empty-heading (heading without
text/label). Semantics labels name controls for existing unlabeled rules. Findings retain the existing
cap of 50. Logical RTL swipe sides are not included.
