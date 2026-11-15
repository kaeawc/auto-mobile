# ProtoViewer: network policy and MCP integration

Part of [ProtoViewer](protoviewer.md).

## 6. Network policy and limits

**Imported prototypes (library imports, and prototypes saved through MCP, which follow the same
policy):** one global switch, "Allow network for imported prototypes", **default off**. When off,
`request` actions fail with a typed error shown to the prototype (`statusKey` `error`). Switching
network off cancels in-flight Android and iOS requests and drops late responses, even after a quick
off/on cycle. On iOS, permission-denial callbacks are bound to the request's consent epoch and
rechecked on the main actor. Response delivery rechecks consent in the same turn that updates
prototype state, replacing obsolete successes and failures with the network-disabled error.
There is no per-host consent. MCP-direct `show` is unaffected. When on:

- The egress check runs in the HTTP client on the resolved address, at every hop. It blocks
  loopback, link-local ranges, the emulator host alias `10.0.2.2`, and the AutoMobile daemon ports.
  **Private LAN ranges (RFC1918) are allowed.** The client resolves once, checks every returned
  address, and connects to a checked address rather than resolving again, and it normalizes
  alternate address spellings before checking. TLS still validates against the original host name.
  The egress check and resolver are an injected interface with a fake in tests.
- **Transport requirement.** The guarantee above requires a client that can connect to a specific
  resolved address. Android's HTTP client can (a custom DNS resolver that returns the checked
  address). iOS `URLSession` cannot: it performs its own lookup and does not pin the answers. Its
  metrics only report a blocked connection after the request may have been sent, so `URLSession`
  does not enforce this boundary for library prototypes.
- **iOS pinned transport.** The iOS app therefore sends library-prototype requests through a
  pin-capable transport built on Network.framework. It opens an `NWConnection` to the checked
  `NWEndpoint.hostPort`, and the checked address is the only one dialled. TLS uses the original
  host name as the server name for SNI and certificate validation. A small HTTP/1.1 client applies
  the existing size, time and header limits. The path monitor and connection state callbacks refuse
  a connection whose remote endpoint differs from the checked address. The transport is
  `PrototypePinnedHttpClient`, selected through `PrototypeNetworkConfiguration.pinned`.
- **iOS network switch.** The iOS app wires the ProtoViewer network switch (#13619): switching off
  cancels in-flight requests and drops late responses across off/on cycles. The app cannot tell a
  pending local-network permission prompt from denial. The switch turns off only when a LAN
  connection ends while still waiting on permission, and explains that the user did not grant
  access and how to restore it. Device verification of the prompt-pending and denied flows is still
  owed. The `URLSession` client stays in use only for MCP-direct `show` flows, which keep today's
  behaviour, and nothing describes it as enforcing this policy.
- Redirects are not followed automatically; each redirect is evaluated as a new request, and an
  https-to-http redirect is refused.
- Forbidden request headers are enforced in both the validator and the runtime. Cleartext http is
  permitted only in the dev flavor.
- Library prototypes use the device route only: `via: "host"` is rejected, and ProtoViewer never
  sets up `adb reverse`.
- ProtoViewer does not implement remote `image` URLs (`image` accepts only `asset`). When it does,
  they count as network: they load only while the switch is on, go through the same egress check
  and pinned transport as `request`, and must be https outside the dev flavor. They never send
  cookies or referrers, and the URL never appears in accessibility text. ProtoViewer rejects
  `via: "host"` image fetches like host requests.
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
  timeout or composition failure shows the corrupt state with Back. On iOS the app allows the same 10 seconds
  from mount to the first laid-out content and then shows the error state. The renderer's first
  layout in a window cancels that watchdog (`PrototypeRenderWatchdog`); it does not catch a blocked
  main thread. Android sets `allowBackup=false` and allows no cleartext outside the dev flavor. iOS
  distributed (non-simulator) builds carry no App Transport Security exception.

## 7. MCP integration

- The host drives whichever build is installed, store or `.dev` (`PROTOVIEWER_PACKAGES` in
  `protoViewerContract.ts`). When both are, it drives the `.dev` build: only someone building
  ProtoViewer has one.
- Android delivery. Android uses adb, the existing device channel (#13621). The host pushes the
  bundle into ProtoViewer's app-scoped inbox,
  `getExternalFilesDir(null)/mcp/inbox/<request>.automobile-proto`. It then runs
  `am start -n <app id>/dev.jasonpearson.automobile.protoviewer.McpActivity` with action
  `….mcp.IMPORT` and the request id (plus an optional label). The `McpActivity` component is
  separate from the exported `ImportActivity` (section 5 step 1). It is exported only to callers
  holding `android.permission.DUMP` and has no intent filters. The adb shell holds DUMP and
  third-party apps cannot, and adb could not start a non-exported activity at all.
- Android import result. The activity reads the inbox file under the same byte caps, deletes it,
  and runs the full import flow. The source is always `mcp`, set by the app, never by the caller or
  the bundle, so the entry is "imported" and the section 6 policy applies. It writes one result,
  `mcp/results/<request>.json`, under a temporary name and renames it. The result is
  `imported`/`opened` with `libraryId` and `label`, `rejected` with `path` and `reason`, or
  `not_found`. The host polls for it and removes it. The exported `ImportActivity` keeps rejecting
  `file://` and its own authority.
- Android storage ownership. On API 30+ scoped storage, a directory the adb shell creates under
  another app's `Android/data` is shell-owned. The app can neither traverse it nor create entries
  in it (#15174, seen on API 37), while the user 0 shell can still write a file into a directory
  the app created. User 0 uses these shared-storage files. Secondary users use the exported,
  DUMP-guarded `McpProvider` at `content://<app id>.mcp` for inbox writes, result reads and
  deletion, because the shell cannot access their shared storage. A missing provider result reads
  as an empty stream.
- Android folder preparation. The app owns `mcp/`, `mcp/inbox/` and `mcp/results/`: it creates
  them on start, and the host never runs `mkdir`. When they are missing on user 0, the host first
  starts `McpActivity` with action `….mcp.PREPARE`, which creates them and answers `prepared`. The
  host's result poll treats "not there yet" as pending until its deadline (a bare `cat` of a
  missing file exits 1, which adb turns into an error). In three cases nothing was imported: the
  folders cannot be prepared, the push is refused, or the app answers `rejected` at `inbox` (it
  cannot see the pushed file). The host then keeps the CtrlProxy save path with a logged warning
  instead of failing the call.
- iOS simulators use the host filesystem inbox without a socket or custom-scheme launch.
  The host resolves the app's own data container and creates
  `Library/Application Support/ProtoViewer/mcp/inbox/` and `results/` (same host uid as the app).
  The app also creates them idempotently on start and never purges this inbox at launch.
  Import writes `inbox/<request>.automobile-proto.tmp` then renames it. The host foregrounds
  ProtoViewer with `simctl launch` and waits within the call budget for `mcp/delivery` to contain
  `file-inbox-v1`. A missing capability returns `unsupported_capability` with rebuild/install
  guidance, without publishing a command or falling back to URL delivery.
- iOS simulator commands. The host then atomically publishes `inbox/<request>.request` via a
  `.tmp` file: JSON with `action: "import"` and optional `label`, or `action: "open"` and
  `libraryId`. Request ids match `[A-Za-z0-9_-]{1,64}` and come from filenames. On activation and
  every 250 ms while active, the app consumes final request files through the same handler as
  legacy URLs. It validates imports, sets `source: mcp` for new entries, and removes each command
  and bundle after the attempt, including malformed commands. Malformed JSON produces a typed
  rejected result. Imports with identical spec bytes and image/font resource identity return the
  existing entry without writes or label changes.
- iOS simulator results. The app atomically publishes `results/<request>.json` using the same
  result shapes as Android. It reports rejections in that file rather than an alert. Open reports
  `opened` only after the viewer loads. Polling stops when the scene becomes inactive.
- iOS simulator cleanup. Host polling treats a missing result as pending until the timer deadline.
  Finally it removes results, commands, bundles and temporary files even after cancellation, with
  an independent cleanup timeout. The app sweeps inbox and result files older than ten minutes and
  retains fresh files, folders and files with unknown ages. An absent app, unresolved container, or
  unusable inbox keeps the template save path with a logged warning. A result deadline is a
  hard failure; retrying the same bundle is safe because imports are idempotent.
  Physical devices keep the template path's existing behavior; `open` needs an iOS simulator.
  There is no `devicectl` delivery to physical devices.
- Capability handshake (#14156). On Android the app writes `mcp/capabilities.json`
  (`{versionCode, versionName, capabilities}`, atomically) whenever it prepares its MCP folders: on
  every start and on PREPARE. Before pushing a save whose spec needs any capability, the host reads
  that report and the installed `versionCode` from `dumpsys package`. It refreshes a report for
  another `versionCode` with PREPARE first. When the spec needs a capability the report lacks, the
  host refreshes once more, because debug builds all keep `versionCode` 1 and a report can be stale
  at an equal version. It then returns `unsupported_capability` with `update`
  `{missingCapabilities, installedVersion, url}` (the Play listing) without pushing.
- Handshake fallbacks. Three cases leave the decision to the app's import gate (section 5 step 5):
  no report, an unreadable report, or a report still for another version. A build from before the
  handshake never writes a report, so it costs no extra launch. Unusable storage keeps the platform
  save path, as for an import. A secondary Android user also defers to the app. Its MCP storage is
  reachable only through the app's provider, which serves inbox writes and result reads, not the
  report.
- iOS handshake. On an iOS simulator the app writes the same report whenever it creates its MCP
  folders, and the host compares it with simctl's `CFBundleVersion`. The app publishes
  asynchronously after it is foregrounded, so a refresh accepts only a rewrite (a new modification
  time or new content) within the timeout. A refresh the app never republishes is unknown and
  defers to the app.
- Trust model for store-installed builds. The host cannot pin a store binary's
  checksum the way it pins CtrlProxy, and the Play-signed binary differs from the GitHub one
  (#14145). It accepts any ProtoViewer signed with the expected certificate (Android) or team
  (iOS); the host does not verify the signer yet.
- Support window: the MCP server supports the three most recent ProtoViewer
  releases. Older builds still get the handshake or the app's own gate, without a guarantee.
- `prototype save`: on Android (for the current user) or an iOS simulator, when ProtoViewer is
  installed, build a canonical bundle (#13616) and route it as above. Otherwise the CtrlProxy or
  template path applies unchanged. `pin` and `icon` describe CtrlProxy launcher shortcuts, which ProtoViewer has not, so
  a save with either keeps the platform save path. The output gains `viewer` `{app, libraryId, label}`
  and a warning that marks the entry as imported.
- `prototype open` (new action) launches a library id (`viewer.libraryId`) through the same
  activity with action `….mcp.OPEN` on Android or the iOS simulator URL route, and returns the same warning.
- There are no MCP `export` or `import` actions, no `listSaved` merge and no live attach.
