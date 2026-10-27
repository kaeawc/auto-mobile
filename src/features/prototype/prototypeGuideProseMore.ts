export const GUIDE_DEVICE_LOOPBACK = `## Requests to localhost from the device

On Android, \`localhost\`, \`127.0.0.1\` and \`[::1]\` in a \`request\` action with \`via: "device"\` mean the
device itself. When you \`show\` such a prototype, the host runs \`adb reverse tcp:<port> tcp:<port>\` for
each literal port (a URL without a port reverses 80, or 443 for https), removes only the reverses it
created when the prototype is dismissed or the device disconnects, and leaves a reverse that already
existed alone. A failed reverse never fails the show; \`inspect\` reports it as \`reverseFailures\`.

A port that is a binding (\`http://localhost:{port}/feed\`) cannot be reversed, because it is only
known when the request runs. \`inspect\` lists such URLs as \`unreversiblePorts\`. Use \`via: "host"\` for
those requests. A saved prototype launched with no host connected gets no reverse either.
On iOS nothing is reversed, and \`localhost\`, \`127.0.0.1\` and \`[::1]\` are refused as
\`blocked_destination\` for \`via: "device"\`: call a Mac-local service by the Mac's LAN address instead.


## Value formatters (#14227)

Use top-level \`derive: {priceText: {of: {data: "/price"}, format: {currency: {code: "USD"}}}}\`
and read \`{derived:priceText}\` in text node text, contentDescription, rich-text spans,
button/FAB labels, topAppBar title, badge text, dialog title/text, and snackbar text.
Other text-kind fields (request url/headers/body, check messages, and
select/segmented/menu/searchBar labels) validate unknown names but show tokens literally on devices.
There are at most 32 names (state-key syntax); unknown reads fail validation.
\`of\` chooses exactly one data pointer, state key or literal \`{value: number|string}\`.
Inside a repeat, \`repeat.derive\` supports at most 8 names, with \`of: {item: "field"}\`
or a literal value; the resulting strings bind as \`{item.priceText}\` using your alias.
Names cannot collide with original row fields; derived fields cannot reference each other.
Host validation checks field references; device-dependent key and emit-name value checks wait for the renderer.

\`format\` has exactly one key with an object: \`number {minFraction?,maxFraction?,grouping?}\`,
\`compact {style?:short|long}\`, \`currency {code:USD}\`, \`percent {minFraction?,maxFraction?}\`,
\`date {style?:short|medium|long}\`, \`time {style?:short|medium|long}\`, or
\`relative {style?:narrow|short|long}\`. Fraction digits are integers 0..20;
min cannot exceed max. Grouping true/default respects locale minimum grouping digits;
false disables grouping entirely. Compact, currency, and percent respect locale minimum grouping digits.
Compact defaults short, date medium,
time short, relative long. Currency codes are three uppercase letters and use CLDR minor units.
Number kinds require finite numbers; percent inputs are ratios (0.256 means 25.6%).
Date/time/relative accept integer epoch milliseconds, YYYY-MM-DD (midnight UTC),
or ISO date-times with seconds and Z or an explicit +hh:mm offset; fractional seconds work.
Invalid or missing inputs display empty text. Optional entry \`locale\` (BCP 47, <=35 characters)
and \`timeZone\` (IANA id, <=128) override device defaults.

Relative time uses an injected clock snapshot, truncates toward zero, and picks the largest
elapsed unit: seconds, minutes (60 s), hours (60 min), days (24 h), months (30 d), years (365 d).
Under one second uses localized now. Exact English fixtures normalize U+202F/U+00A0 to spaces;
foreign currency symbols, narrow relative text, now wording and non-English CLDR data can vary
by engine and use structural comparisons. Set locale, zone and clock for deterministic previews.
Both derive maps require \`prototype_format_v1\`; use literal strings with older renderers.
\`dateTime\`, \`duration\`, \`plural\`, and \`fileSize\` are unsupported follow-ups.
`;

export const GUIDE_TIMERS = `### Timers

Timer actions and \`onAppear\` require \`prototype_timers_v1\`.
The root and nodes declaring \`visibleWhen\` may set \`onAppear\` to 1..32 ordinary actions.
They run on first show if visible, and on each hidden-to-visible edge; visible-to-visible
and a same-id show without reset do not run them again. Repeat placeholders bind as in onTap.
Each list is atomic, validates like a tap, and emits change for a net state change, without
restarting idle TTL. A handler runs at most once per interaction, bounded by the action-depth limit.
For a splash, put \`onAppear:[{type:"startTimer",id:"splash",afterMs:2000,
actions:[{type:"setState",key:"loading",value:false}]}]\` on the root and use
\`visibleWhen:{key:"loading",equals:false}\` on content. Hiding a node does not cancel its timer.
Start a timer from any action list:
\`{type:"startTimer",id:"tick",afterMs:100,everyMs:1000,maxRuns:10,actions:[{type:"emit",name:"tick"}]}\`.
\`afterMs\` is required; it and optional \`everyMs\` are integers 100..3600000 ms.
\`maxRuns\` is 1..10000 total fires, including the first, and requires \`everyMs\`.
Without maxRuns, repeats continue until cancelled or dismissed. Actions contain 1..32 entries,
with the same validation and nesting limit as request follow-ups. IDs are literal strings of
1..64 characters, never repeat-bound; at most eight distinct startTimer ids per spec.
\`{type:"cancelTimer",id:"tick"}\` removes a timer; unknown ids are no-ops. The host warns
on show and patch if no startTimer declares the cancelled id; devices do not validate that advisory.

Starting a live id replaces its schedule and resets runs. Each fire is one atomic interaction:
invalid planned writes drop the whole fire but count the run; a net state change emits one change.
Self-cancellation stops repeats, and a replacement started during a fire wins. Repeats schedule
from planned fire time without drift. Timers pause while hidden or inactive, retaining remaining
time (screenshot capture does not pause); dismiss, teardown and any replacing show cancel them.
Patch preserves them. Fires never restart idle TTL.

\`prototype {action:"simulate",id,advanceTimeMs:1000}\` advances without waiting (integer
1..3600000), requiring the same capability. It returns \`fired\`; paused timers fire zero times.
Due timers run chronologically, ties by start order, including timers started during advancement.
Exactly 10000 due fires succeed. If another fire is still due, advance stops at the last fire with
an error and fired=10000, keeping pending timers for the next call. Real scheduling continues from the shifted clock.
Inspect reports \`timers:[{id,nextFireInMs,runs}]\`, ordered by remaining time then start order;
remaining time is nonnegative and frozen while paused. A capable device yields an empty array
when no timers are live.
`;

export const GUIDE_STRINGS_SEMANTICS = `## Strings and semantics

Top-level \`strings\` requires \`prototype_strings_v1\`: \`{default: {title: "Cart", items: {one: "{#} item", other: "{#} items"}}, fr: {title: "Panier"}}\`.
Use \`{t:title}\` or \`{t:items|2}\` in display text, spans, semantics.label or semantics.hint.
Counts are non-negative integer literals (1–9 digits) or \`{data:/pointer}\`; state-key counts are unsupported.
Pipeline: data substitution, then translation, then state binding. Translation values may contain state bindings; translated text is never scanned again for translations. \`{#}\` inserts the decimal count in a plural form. Invalid runtime counts use other.
show \`locale\` (locale tag, max 35 characters) overrides device preferred locales for that show; omitted follows device locales, which re-resolve live.
Each requested locale tries its full tag then shorter prefixes, deduplicated, then default. Tags match case-insensitively with underscores normalized to hyphens. Lookup is per key; the supplying table language decides plurals (default uses the first requested language, else en).
Integer plural groups: ja/zh/ko/vi/th/id/ms/lo/km/my use other; fr/pt/hi/bn/fa/gu/kn/am use one for 0–1; ru/uk/be and pl use one/few/many; cs/sk use one/few/other; ar uses zero/one/two/few/many/other; remaining languages use one at 1, other otherwise. Missing forms use other; million-multiple Romance many is outside v1.
Limits: 16 tables, 512 keys per table, 2048 characters per nonempty value; default and every plural other form are required. Keys use letters/underscore followed by letters/digits/underscore/dot/hyphen, at most 64 characters. Values cannot contain translation, data or platform placeholders.
With an explicit locale, \`platformNotes\` construct \`strings.fallback\` (platform all) lists up to 20 referenced keys reaching default. Advisory lint reports missing-translation and unknown-translation-key.
Pseudo-localisation transforms each table value and plural form while preserving keys, tags, category names and bindings; strings is opaque to node walking. Node translation placeholders stay intact; semantics label and hint are display text.

Every node accepts \`semantics {heading?,liveRegion?: "polite"|"assertive",group?,label?,hint?,traits?: ["button"|"image"|"selected"]}\`, requiring \`prototype_semantics_v1\`. At least one field is required; traits are unique (1–3). Label/hint are nonempty and accept translations, data and state bindings. Label conflicts with contentDescription.
Heading enables screen-reader navigation; empty-heading lint flags headings without text/label. Group contains child traversal. Android maps heading/liveRegion/traversal group, label to contentDescription, hint to onClickLabel for tap actions else stateDescription, and traits to Role.Button/Role.Image/selected. iOS maps header/button/image/selected traits, contain grouping, label/hint, and live-region change announcements (not initial render; assertive has high speech priority).
Android observe exposes heading as the string "true" and live-region as polite/assertive; iOS snapshots currently expose no SwiftUI traits. Logical RTL swipe sides are outside this capability.
`;

export const GUIDE_TEST_SESSIONS = `## User-testing sessions

Call \`prototype {action:"testSessionBegin", id, goal?, cohort?}\` after showing a prototype.
The host records accepted events without consuming \`awaitEvent\`. A goal is a screen label
such as \`checkout/done\`; reaching it marks completion. Cohort is a free label, with no
cross-session aggregation. \`testSessionEnd {id}\` stops recording and returns JSON plus
Markdown. Dismissal or session release also ends recording. \`testSessionReport {id}\`
reads the latest session for this scope, or pass \`testSessionId\` for a stored one.
Only one session may be active per device and prototype.

Reports include screen visits, time, abandonment, validation failures and pager changes.
Labels use the deepest stack's top screen as \`stack/screen\` (ties use the lowest stack id),
or \`(root)\`. Text values, payloads, context and state snapshots are never stored;
non-secure changes retain only keys, string lengths or value types and validity.
Secure fields are excluded. Up to 5,000 sanitized events are retained per session; extra
events are counted as dropped and the report is marked truncated. The newest 50 ended
sessions are kept per device/prototype.

To record dead taps, show with \`window.deadTaps: true\` on a device advertising
\`prototype_dead_tap_v1\`; an older agent is refused. Dead taps are single-pointer taps
inside the prototype window that no interactive node handled, excluding drags, scrolling
and app taps outside the window. Their payload has only screen ids and coordinates,
rounded to one decimal in window-local dp (points on iOS). Reports include counts,
up to 200 points per screen and a 48-unit grid. There is no screenshot overlay yet.

Stack transition patterns: \`sharedAxisX\`, \`sharedAxisY\`, \`fadeThrough\` and \`zoom\` (and a push/replace
\`source\`) require \`prototype_stack_patterns_v1\`; zoom needs a source naming exactly one shared key inside the target stack's screens.
With \`prototype_zoom_transition_v1\`, zoom morphs source-to-root on Android and uses native
interactive zoom on iOS 18+. Older agents keep fadeThrough (Android) or platform push (iOS 17);
platformNotes reports the fallback. The new capability reports rendering, not spec acceptance.
Reduced motion crossfades and motion off snaps; composed iOS patterns pop non-interactively.
`;

export const GUIDE_DATA_ACTIONS = `### Data actions

A tap can change \`/data\` on the device without the agent answering it. Data actions write a
member of \`data\`; each \`path\` is \`/data\` plus a non-empty data pointer (the same syntax and
\`MAX_PROTOTYPE_DATA_POINTER_LENGTH\` as \`{data: pointer}\`), so the whole document cannot be
written:

- \`{type: "setData", path, value}\` creates or replaces an object member, or replaces an existing
  array element. A missing parent is an error.
- \`{type: "appendData", path, value}\` appends to the existing array at \`path\`.
- \`{type: "prependData", path, value}\` inserts one row at the start; list maxItems trims from the end.
- \`{type: "removeData", path}\` removes an existing member or element; later elements shift down.

\`value\` uses the emit.context binding forms except \`page\`: \`{value: json}\` is the literal,
\`{state: key}\` reads state, \`{data: pointer}\` reads data, and \`{item: field}\` and
\`{index: true}\` read the repeat row (repeat only). A written value must be data: strings, booleans,
finite numbers, arrays and objects, without null. Inside a repeat, a whole \`{index}\` segment of
\`path\`, as in \`/data/cart/{index}\`, is bound to the current row; \`{index}\` anywhere else, or
\`{alias.field}\`, is rejected.

The host validates pointer syntax and \`{index}\` use, rejects a literal value data cannot hold, and
rejects an \`appendData\` or \`prependData\` whose target resolves in the spec's own \`data\` to something other than an
array. A target that only exists after earlier writes is checked by the device. A write that would
leave \`data\` over \`MAX_PROTOTYPE_DATA_WRITE_BYTES\` (or over a depth or array limit), or whose
target is missing or not an array, changes nothing.
Actions run in order, so a later action sees an earlier write.

Each write is a \`change\` event with \`name\` the written \`/data/...\` path and \`payload\`
\`{op: "set"|"append"|"remove", value?, revision}\`; \`awaitEvent\` with \`kind: "change"\` returns it.
\`revision\` is the device revision after the write, the same counter as a patch result's. The host
applies each write to its own copy of the spec and to \`status\` data, so both stay current. The
agent's \`/data\` patches and a device's writes never silently lose each other: once the device
has written a prototype's data, a patch with \`/data\` ops needs \`baseRevision\` (the latest
\`revision\` the agent has seen) and is refused with \`conflict: {revision, state, data}\` when a write
newer than that revision touched an overlapping path (\`data\` lists those paths). A \`show\` makes its
own \`data\` authoritative again and clears the history.

Data actions require \`prototype_data_actions_v1\`. A show or patch result that contains one is
refused on a device without it, before anything is shown or sent.


### Realtime channels

The validated contract requires \`prototype_platform_realtime_v1\`; current Android and iOS
runtimes do not advertise it. A root \`channels\` map holds at most four named channels and
requires \`requires.platform:["realtime"]\`. Each channel declares \`kind:"websocket"|"sse"\`
and \`url\` (ws/wss or http/https respectively), using request URL placeholders and length rules.
Optional fields: \`protocols\` (WebSocket only, up to four), \`headers\` (up to 16, request rules
plus refusing Sec-WebSocket-* and Last-Event-ID), \`via:"host"|"device"\` (host default),
\`connect:"onShow"|"manual"\` (onShow default), declared string \`statusKey\`,
\`decode:"json"|"text"\` (json default), \`reconnect\`, \`routes\`, \`onOpen/onClose/onError\`.
Device routing additionally requires \`prototype_platform_realtime_device_v1\`.
Reconnect fields are integer \`maxAttempts:0..20\`, \`initialDelayMs>=100\`,
\`maxDelayMs<=60000\`, with initial <= max. Up to 16 routes use \`when:{pointer,equals}\`,
\`{pointer,exists:boolean}\`, \`{event:SSE-name}\`, or omit when. Their actions are state/data
writes; request and navigation are refused. In channel callbacks and platform handlers,
\`{event:"/message"}\` reads decoded event data and \`{event:""}\` reads the whole event.
Calls use \`{type:"platform",call:"realtime.connect"|"realtime.disconnect",args:{channel:"chat"}}\`
and \`realtime.send\` with \`args:{channel:"chat",body:{value:json}}\` (WebSocket only).
Read live counters with \`{platform:"/realtime/chat/framesIn"}\`; state keys are status, attempt,
framesIn, framesDropped, closeCode, closeReason and error. Events are realtime.status and realtime.frame.
The same capability gates \`appendData.maxItems\` and \`upsertData {path,key,value,maxItems?}\`.
Upsert replaces the first row whose key pointer matches the incoming value, otherwise appends;
missing incoming identity is an error. maxItems is 1..2000 and drops oldest rows before limits apply.
Frame/send budgets are 65536/16384 bytes, with eight open channels per device and a 50 ms flush budget.
Transport, lifecycle and routing execution remain unavailable. Flush-window coalescing is an open
decision; no coalescing behavior is implemented.
`;

export const adaptiveGuideProse = `
### Adaptive panes and navigation

\`adaptive\` needs \`prototype_adaptive_v1\` and a closed \`kind\`:
- \`listDetail\`: \`list\` and \`detail\` node slots, \`selectionKey\` naming a declared string state key. Empty string means no selection; selecting pushes detail in compact layout and Back clears the key.
- \`navigationSuite\`: 1–8 unique \`items: [{value,label}]\`, \`stateKey\` naming a declared string whose value matches an item, and a \`content\` node slot. Item taps write that value. Use conditions on the key to choose content.
- \`supporting\`: \`main\` and \`supporting\` node slots, \`openKey\` naming a declared boolean. Close clears the key.

Widths are native per platform. Android Material adaptive scaffolds split panes at expanded and use bar/rail/drawer at compact/medium/expanded. iOS horizontalSizeClass regular uses split/sidebar/inspector, compact uses stack/bottom bar/sheet. There is no shared breakpoint or \`minWidth\`; \`platformNotes\` reports the different rules on show. iOS draws Material-styled containers under every design until native platform containers are available.
`;

export const GUIDE_PLATFORM_NAMESPACES = `## Platform namespaces

Choose styling in this order:
1. Portable node/window fields express behavior on both platforms: use \`button.variant: "outlined"\`
   for an outlined button, or \`style.cornerRadius\` for an authored corner.
2. Portable theme tokens express a shared visual system: set \`theme.colors.primary\` once rather
   than repeating a color on each button; use theme typography and corner tokens for shared styles.
3. \`theme.design: "platform"\` chooses native platform treatment for covered controls (the default);
   \`"material"\` keeps the shared Material appearance. Check design fallback notes for custom controls.
4. Use \`ios\`/\`android\` only for semantics with no portable meaning, such as
   \`ios: {buttonStyle: "glass"}\` or \`android: {predictiveBack: {style: "none"}}\` on a stack.

Namespaces are closed objects on nodes, window and theme; each field has a contract \`why\`.
Own-platform blocks require \`prototype_platform_namespace_v1\`. Foreign blocks are accepted and
ignored with paths in \`platformNotes\`; unknown fields are rejected even in foreign blocks.
iOS glass buttons need 26 and otherwise use bordered buttons; hover needs 17 and is render-only
(no pointer input). Custom tab bars, app bars and sheets cannot apply \`tab.role\`,
\`bottomAccessory\` (node-only), \`navigationTitle\` or \`sheet.sizing\`; these are reported as ignored.
Window/theme namespace fields likewise have no applicable node and are reported as ignored.
Android \`indication: "ripple"|"none"\` controls the node's clickable feedback; motion-off still wins.
Stack \`predictiveBack.style\` uses the existing pop for \`default\`, horizontal movement with fade
for \`crossActivity\` within the prototype activity, or snaps without predictive scrubbing for \`none\`.
Use notes to confirm what the current renderer can apply before relying on a namespace field.`;
