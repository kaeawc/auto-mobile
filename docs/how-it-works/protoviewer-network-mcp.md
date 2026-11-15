# ProtoViewer: network policy and MCP integration

Part of [ProtoViewer](protoviewer.md).

## 6. Network policy and limits

**Imported prototypes (library imports, and prototypes saved through MCP, which follow the same
policy):** one global switch, "Allow network for imported prototypes", **default off**. When off,
`request` actions fail with a typed error shown to the prototype (`statusKey` `error`). Switching
network off cancels in-flight Android and iOS requests and drops late responses, even after a quick
off/on cycle. On iOS, permission-denial callbacks are bound to the request's consent epoch and
rechecked on the main actor; response delivery rechecks consent in the same turn that updates
prototype state, replacing obsolete successes and failures with the network-disabled error.
There is no per-host consent. MCP-direct `show` is unaffected. When on:

- The egress check runs in the HTTP client on the resolved address, at every hop. It blocks
  loopback, link-local ranges, the emulator host alias `10.0.2.2`, and the AutoMobile daemon ports.
  **Private LAN ranges (RFC1918) are allowed.** The client resolves once, checks every returned
  address, and connects to a checked address rather than resolving again, and it normalizes
  alternate address spellings before checking. TLS still validates against the original host name.
- **Transport requirement.** The guarantee above requires a client that can connect to a specific
  resolved address. Android's HTTP client can (a custom DNS resolver that returns the checked
  address). iOS `URLSession` cannot: it performs its own lookup, the answers are not pinned, and
  its metrics only report a blocked connection after the request may have been sent, so
  `URLSession` does not enforce this boundary for library prototypes. The iOS app therefore sends
  library-prototype requests through a pin-capable transport built on Network.framework
  (`NWConnection` to the checked `NWEndpoint.hostPort`, TLS with the original host name as the
  server name for SNI and certificate validation, and a small HTTP/1.1 client with the existing
  size, time and header limits). The checked address is the only one dialled. The path monitor and
  connection state callbacks are used to refuse a connection whose remote endpoint differs from the
  checked address. The transport is `PrototypePinnedHttpClient`, selected through
  `PrototypeNetworkConfiguration.pinned`. The ProtoViewer network switch is wired on iOS (#13619): switching off cancels
  in-flight requests and drops late responses across off/on cycles. A pending local-network permission
  prompt cannot be distinguished from denial: the switch turns off only when a LAN connection ends
  while still waiting on permission, and explains that access was not granted and how to restore it.
  Device verification of the prompt-pending and denied flows is still owed. `URLSession` stays in use only for MCP-direct
  `show` flows, which keep today's behaviour, and it is never described as enforcing this policy.
  The egress check and resolver are an injected interface with a fake in tests.
- Redirects are not followed automatically; each redirect is evaluated as a new request, and an
  https-to-http redirect is refused.
- Forbidden request headers are enforced in both the validator and the runtime. Cleartext http is
  permitted only in the dev flavor.
- Library prototypes use the device route only: `via: "host"` is rejected, and ProtoViewer never
  sets up `adb reverse`.
- Remote `image` URLs are not implemented (`image` accepts only `asset`). When they are, they count
  as network: they load only while the switch is on, go through the same egress check and pinned transport as
  `request`, and must be https outside the dev flavor. They never send cookies or referrers, and the
  URL never appears in accessibility text. `via: "host"` image fetches are rejected like host requests.
- A provenance indicator lives in an app-reserved region outside the spec's drawable bounds and
  stays visible while network is enabled.
- Storage is keyed by library id; a new entry starts empty. The bundle carries `spec.id` inside
  `spec.json` but no app-assigned library id, so there is no bundle-id comparison. The transport
  verifies `bundle.json.specSha256` against the inflated `spec.json` before the composite import
  identity comparison described above.
- Imported-prototype content is marked as imported in `observe` and `awaitEvent`; `open` states
  when an entry is imported; host attach is off by default for imported prototypes.
- Limits: 200 prototypes and 100 MiB per library, enforced at commit and on load, plus a render
  watchdog. Android allows 10 seconds for loading and the first successful content composition;
  timeout or composition failure shows the corrupt state with Back. iOS allows the same 10 seconds
  from mount to the first laid-out content (`PrototypeRenderWatchdog`, cancelled by the renderer's
  first layout in a window) and then shows the error state; a blocked main thread is not caught. Android sets `allowBackup=false` and allows no cleartext outside the dev flavor. iOS
  distributed (non-simulator) builds carry no App Transport Security exception.

## 7. MCP integration

- The host drives whichever build is installed, store or `.dev` (`PROTOVIEWER_PACKAGES` in
  `protoViewerContract.ts`). When both are, it drives the `.dev` build: only someone building
  ProtoViewer has one.
- Android uses adb, the existing device channel (#13621): the host pushes the bundle into
  ProtoViewer's app-scoped inbox, `getExternalFilesDir(null)/mcp/inbox/<request>.automobile-proto`,
  then runs `am start -n <app id>/dev.jasonpearson.automobile.protoviewer.McpActivity` with action
  `….mcp.IMPORT` and the request id (plus an optional label). `McpActivity` is a separate component
  from the exported `ImportActivity` (section 5 step 1). It is exported only to callers holding
  `android.permission.DUMP` and has no intent filters: the adb shell holds DUMP and third-party apps
  cannot, and a non-exported activity could not be started from adb at all. It reads the inbox
  file under the same byte caps, deletes it, and runs the full import flow; the source is always
  `mcp`, set by the app, never by the caller or the bundle, so the entry is "imported" and the
  section 6 policy applies. It writes one result, `mcp/results/<request>.json`
  (`imported`/`opened` with `libraryId` and `label`, `rejected` with `path` and `reason`, or
  `not_found`), under a temporary name and renames it; the host polls for it and removes it. The
  exported `ImportActivity` keeps rejecting `file://` and its own authority. On API 30+ scoped
  storage a directory the adb shell creates under another app's `Android/data` is shell-owned and
  the app can neither traverse it nor create entries in it (#15174, seen on API 37), while the
  user 0 shell can still write a file into a directory the app created. User 0 uses these
  shared-storage files; secondary users use the exported, DUMP-guarded `McpProvider` at
  `content://<app id>.mcp` for inbox writes, result reads and deletion because their shared
  storage is inaccessible to the shell. A missing provider result reads as an empty stream.
  The app owns `mcp/`, `mcp/inbox/` and `mcp/results/`: it creates them on start, and the host
  never runs `mkdir`. When they are missing on user 0, the host first starts `McpActivity` with
  action `….mcp.PREPARE`, which creates them and answers `prepared`. The host's result poll treats "not there yet" as pending until its
  deadline (a bare `cat` of a missing file exits 1, which adb turns into an error). When the
  folders cannot be prepared, the push is refused, or the app answers `rejected` at `inbox` (it
  cannot see the pushed file), nothing was imported and the host keeps the CtrlProxy save path
  with a logged warning instead of failing the call.
- iOS simulators use the host filesystem inbox without a socket or custom-scheme launch.
  The host resolves the app's own data container and creates
  `Library/Application Support/ProtoViewer/mcp/inbox/` and `results/` (same host uid as the app);
  the app also creates them idempotently on start and never purges this inbox at launch.
  Import writes `inbox/<request>.automobile-proto.tmp` then renames it. The host foregrounds
  ProtoViewer with `simctl launch` and waits within the call budget for `mcp/delivery` to contain
  `file-inbox-v1`; a missing capability returns `unsupported_capability` with rebuild/install
  guidance, without publishing a command or falling back to URL delivery.
  It then atomically publishes `inbox/<request>.request` via a `.tmp` file: JSON with
  `action: "import"` and optional `label`, or `action: "open"` and `libraryId`.
  Request ids match `[A-Za-z0-9_-]{1,64}` and come from filenames. On activation and every
  250 ms while active, the app consumes final request files through the same handler as legacy
  URLs. It validates imports, sets `source: mcp` for new entries, and removes each command and bundle
  after the attempt, including malformed commands. Malformed JSON produces a typed rejected
  result. Imports with identical spec bytes and image/font resource identity return the existing
  entry without writes or label changes.
  The app atomically publishes `results/<request>.json` using the same result shapes as Android.
  Rejections are reported in that file rather than an alert. Open reports `opened` only after
  the viewer loads. Polling stops when the scene becomes inactive.
  Host polling treats a missing result as pending until the timer deadline; finally it removes
  results, commands, bundles and temporary files even after cancellation, with an independent
  cleanup timeout. The app sweeps inbox and result files older than ten minutes; fresh files,
  folders and files with unknown ages are retained. An absent app, unresolved container, or
  unusable inbox keeps the template save path with a logged warning. A result deadline is a
  hard failure; retrying the same bundle is safe because imports are idempotent.
  Physical devices keep the template path's existing behavior; `open` needs an iOS simulator.
  There is no `devicectl` delivery to physical devices.
- Capability handshake (#14156). On Android the app writes `mcp/capabilities.json`
  (`{versionCode, versionName, capabilities}`, atomically) whenever it prepares its MCP folders: on
  every start and on PREPARE. Before pushing a save whose spec needs any capability, the host reads
  the installed `versionCode` from `dumpsys package` and that report; a report for another
  `versionCode` is refreshed with PREPARE first. When the spec needs a capability the report lacks,
  the host refreshes once more (debug builds all keep `versionCode` 1, so a report can be stale at
  an equal version) and then returns `unsupported_capability` with `update`
  `{missingCapabilities, installedVersion, url}` (the Play listing) without pushing. No report
  (a build from before the handshake, which never writes one, so no extra launch), an unreadable
  report, or a report still for another version leaves the decision to the app's import gate
  (section 5 step 5); unusable storage keeps the platform save path, as for an import. A secondary
  Android user also defers to the app: its MCP storage is reached only through the app's provider,
  which serves inbox writes and result reads, not the report. On an iOS simulator the app writes the
  same report whenever it creates its MCP folders, and the host compares it with simctl's
  `CFBundleVersion`. The app publishes asynchronously after it is foregrounded, so a refresh accepts
  only a rewrite (a new modification time or new content) within the timeout; a refresh the app
  never republishes is unknown and defers to the app.
- Trust model for store-installed builds. The host cannot pin a store binary's
  checksum the way it pins CtrlProxy, and the Play-signed binary differs from the GitHub one
  (#14145). It accepts any ProtoViewer signed with the expected certificate (Android) or team
  (iOS); the host does not verify the signer yet.
- Support window: the MCP server supports the three most recent ProtoViewer
  releases. Older builds still get the handshake or the app's own gate, without a guarantee.
- `prototype save`: on Android (for the current user) or an iOS simulator, when ProtoViewer is installed, build a
  canonical bundle (#13616) and route it as above; otherwise the CtrlProxy or template path is
  unchanged. `pin` and `icon` describe CtrlProxy launcher shortcuts, which ProtoViewer has not, so
  a save with either keeps the platform save path. The output gains `viewer` `{app, libraryId, label}`
  and a warning that the entry is imported.
- `prototype open` (new action) launches a library id (`viewer.libraryId`) through the same
  activity with action `….mcp.OPEN` on Android or the iOS simulator URL route, and returns the same warning.
- There are no MCP `export` or `import` actions, no `listSaved` merge and no live attach.
