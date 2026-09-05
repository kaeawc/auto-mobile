import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Concurrency-clean rewrite of the CtrlProxy iOS service (WebDriverAgent-style WebSocket
/// bridge). Owns the single instances of every collaborator and fills the production seams
/// the earlier phases left open.
///
/// Rewrite archetype — **`@MainActor`**. It constructs and holds the `@MainActor` UI domain
/// (`ElementLocator`, `GesturePerformer`, `HierarchyDebouncer`, `DisplayLinkFPSMonitor`) plus
/// the `Sendable` off-main collaborators (`PerfProvider`, the SDK clients/cache, the
/// `WebSocketServer`). The reference coordinator was a plain class that set `var` hooks on the
/// server *after* construction; the rewrite server's seams are immutable init-injected
/// `@Sendable` closures (closing race #4), so this wires them at construction. Those closures
/// fire off the main actor, so any `@MainActor` work (sampler start/stop, the SDK-hierarchy
/// re-broadcast) hops back via `Task { @MainActor }`, reaching the coordinator through a
/// late-bound weak box because `self` is not yet available while the server is being built.
@MainActor
public final class CtrlProxy {
    public static let defaultPort: UInt16 = 8765

    private let perf: PerfProvider
    private let frameContext: FrameContext
    private let sdkHierarchyCache: SdkHierarchyCache
    private let sdkHierarchyClient: SdkHierarchyClient
    private let sdkDatabaseClient: SdkDatabaseClient
    private let elementLocator: ElementLocator
    private let gesturePerformer: GesturePerformer
    private let hierarchyDebouncer: HierarchyDebouncer
    private let commandHandler: CommandHandler
    private let fpsMonitor: DisplayLinkFPSMonitor
    private let server: WebSocketServer
    private let coordinatorBox: WeakCoordinator

    /// Set by `stop()` so a client-presence callback that was queued onto the main actor while
    /// `stop()` was holding it (blocked inside the synchronous `server.stop()`) cannot restart
    /// the samplers on a torn-down service once teardown completes (#5834 review). Cleared by
    /// `start()` so a stopped instance can be restarted.
    private var isStopped = false

    /// Whether the device samplers are currently active. Maintained by `startSamplers()` /
    /// `stopSamplers()`; exposed read-only so the lifecycle regression test can observe that a
    /// post-`stop()` presence callback does not resurrect them.
    private(set) var samplersActive = false

    #if canImport(XCTest) && os(iOS)
        private var application: XCUIApplication?
    #endif

    /// Creates the service with the specified port. Production entry point: the public API keeps
    /// the internal `ProxyTimer`/`SystemTimer` seam hidden (a public init cannot expose them), so
    /// this convenience initializer supplies the real `SystemTimer` and delegates to the internal
    /// designated initializer below — which does expose the timer seam, to the in-module lifecycle
    /// test (`CtrlProxyLifecycleTests`) that substitutes a `FakeProxyTimer`.
    public convenience init(
        port: UInt16 = defaultPort,
        storageInspector: (any StorageInspecting)? = DefaultStorageInspecting()
    ) {
        self.init(port: port, storageInspector: storageInspector, hierarchyPollTimer: SystemTimer())
    }

    /// Designated initializer. `hierarchyPollTimer` is injected so tests can drive the
    /// `HierarchyDebouncer` with a `FakeProxyTimer` and stay deterministic. It is `internal`
    /// (not `public`) because `ProxyTimer` is a non-public seam — the reason the reference's
    /// `Timer` injection was dropped from the public API — so production callers reach the
    /// service through the two-argument convenience initializer above, which supplies the real
    /// `SystemTimer`. `hierarchyPollTimer` has no default, which keeps this initializer
    /// unambiguous against that convenience one.
    init(
        port: UInt16 = defaultPort,
        storageInspector: (any StorageInspecting)? = DefaultStorageInspecting(),
        hierarchyPollTimer: any ProxyTimer
    ) {
        let perf = PerfProvider()
        let frameContext = FrameContext()
        let sdkHierarchyCache = SdkHierarchyCache()
        let sdkHierarchyClient = SdkHierarchyClient()
        let sdkDatabaseClient = SdkDatabaseClient()
        #if os(iOS)
            let elementLocator = ElementLocator(perf: perf)
        #else
            let elementLocator = ElementLocator()
        #endif
        let gesturePerformer = GesturePerformer(elementLocator: elementLocator)
        let hierarchyDebouncer = HierarchyDebouncer(
            hierarchyExtractor: elementLocator,
            perf: perf,
            timer: hierarchyPollTimer
        )
        let commandHandler = CommandHandler(
            elementLocator: elementLocator,
            gesturePerformer: gesturePerformer,
            perf: perf,
            storageInspector: storageInspector,
            sdkHierarchyClient: sdkHierarchyClient,
            sdkHierarchyCache: sdkHierarchyCache,
            sdkDatabaseClient: sdkDatabaseClient,
            hierarchyDebouncer: hierarchyDebouncer,
            frameContext: frameContext
        )
        let fpsMonitor = DisplayLinkFPSMonitor()
        let coordinatorBox = WeakCoordinator()

        // Immutable server seams (race #4). They fire off the main actor:
        // - `onSdkEventBatch` extracts SDK hierarchy events into the (lock-confined) cache
        //   synchronously on the network queue, then hops to the main actor to re-broadcast
        //   the last XCUITest hierarchy enriched with the fresh SDK metadata (the reference's
        //   `SdkHierarchyRefreshPublisher`, inlined as `publishSdkHierarchyRefresh`).
        // - `drainLogEvents` merges OSLog entries into `GET /sdk-events`.
        // - `onClientPresenceChanged` gates the device samplers on client presence (#5477).
        let server = WebSocketServer(
            port: port,
            commandHandler: commandHandler,
            perf: perf,
            frameContext: frameContext,
            onSdkEventBatch: { [sdkHierarchyCache, coordinatorBox] data in
                SdkHierarchyExtractor.extractIfPresent(from: data, into: sdkHierarchyCache) {
                    Task { @MainActor in coordinatorBox.coordinator?.publishSdkHierarchyRefresh() }
                }
            },
            drainLogEvents: { OSLogReaderHolder.shared.drain() },
            onClientPresenceChanged: { [coordinatorBox] hasClients in
                Task { @MainActor in
                    coordinatorBox.coordinator?.applyClientPresence(hasClients)
                }
            }
        )

        self.perf = perf
        self.frameContext = frameContext
        self.sdkHierarchyCache = sdkHierarchyCache
        self.sdkHierarchyClient = sdkHierarchyClient
        self.sdkDatabaseClient = sdkDatabaseClient
        self.elementLocator = elementLocator
        self.gesturePerformer = gesturePerformer
        self.hierarchyDebouncer = hierarchyDebouncer
        self.commandHandler = commandHandler
        self.fpsMonitor = fpsMonitor
        self.server = server
        self.coordinatorBox = coordinatorBox

        // Debouncer callbacks (settable, `@MainActor`). The result callback broadcasts a
        // changed hierarchy (SDK-enriched); the transition callback advances the frame-context
        // epoch. Installed once here; the debouncer only fires them once started by a client.
        hierarchyDebouncer.setOnTransition { [weak self] hierarchy in
            self?.frameContext.recordTransition(to: hierarchy)
        }
        hierarchyDebouncer.setOnResult { [weak self] result in
            switch result {
            case let .changed(hierarchy, hash, extractionTimeMs):
                print("[CtrlProxy] Hierarchy changed (hash=\(hash), extraction=\(extractionTimeMs)ms), broadcasting")
                guard let self else { return }
                let enriched = self.commandHandler.enrichWithCachedSdkHierarchy(hierarchy)
                self.server.broadcastHierarchyUpdate(enriched)
            case .unchanged:
                // Don't broadcast unchanged results (animation mode).
                break
            case let .error(message):
                print("[CtrlProxy] Hierarchy extraction error: \(message)")
            }
        }

        coordinatorBox.coordinator = self
    }

    /// Re-emits the latest XCUITest hierarchy after an SDK-only change. The XCUITest
    /// structural hash does not include in-process SDK metadata, so chrome-only changes need
    /// this explicit path to refresh normal observations (the reference `SdkHierarchyRefreshPublisher`).
    private func publishSdkHierarchyRefresh() {
        guard let hierarchy = hierarchyDebouncer.getLastHierarchy() else { return }
        let enriched = commandHandler.enrichWithCachedSdkHierarchy(hierarchy)
        server.broadcastHierarchyUpdate(enriched)
    }

    /// Applies a client-presence transition to the device samplers. The presence seam routes
    /// through here (rather than calling start/stop inline) so the `isStopped` guard in
    /// `startSamplers()` also covers a presence-`true` callback that raced `stop()`. Sampler
    /// stop is idempotent, so the `false` path needs no guard.
    func applyClientPresence(_ hasClients: Bool) {
        if hasClients {
            startSamplers()
        } else {
            stopSamplers()
        }
    }

    /// Starts the device-side samplers when the first client connects. All three starts are
    /// idempotent. Cross-platform: `DisplayLinkFPSMonitor` / `OSLogReaderHolder` no-op where
    /// their platform APIs are unavailable. No-ops after `stop()` (`isStopped`) so a
    /// presence-`true` callback that was queued while `stop()` held the main actor cannot
    /// resurrect sampling on a torn-down service.
    private func startSamplers() {
        guard !isStopped else { return }
        hierarchyDebouncer.start()
        OSLogReaderHolder.shared.start()
        fpsMonitor.startMonitoring { [weak self] snapshot in
            self?.server.broadcastPerformanceUpdate(snapshot)
        }
        samplersActive = true
        print("[CtrlProxy] Device samplers active (hierarchy debouncer, OSLog reader, FPS monitor)")
    }

    /// Stops the device-side samplers when the last client disconnects.
    private func stopSamplers() {
        OSLogReaderHolder.shared.stop()
        fpsMonitor.stopMonitoring()
        hierarchyDebouncer.stop()
        samplersActive = false
        print("[CtrlProxy] Device samplers paused (no clients connected)")
    }

    #if canImport(XCTest) && os(iOS)
        /// Default bundle ID to use when none is specified (iOS Springboard/home screen).
        public static let defaultBundleId = "com.apple.springboard"

        /// Sets the application under test with its bundle ID.
        public func setApplication(_ app: XCUIApplication, bundleId: String? = nil) {
            application = app
            if let bundleId {
                elementLocator.setApplication(app, bundleId: bundleId)
            } else {
                elementLocator.setApplication(app)
            }
            gesturePerformer.setApplication(app)
        }

        /// Activates the target application and starts the service. Sampler start/stop is
        /// gated on client presence via the server's presence seam (wired in `init`), so an
        /// idle session with no client places no continuous load on the app under test (#5477).
        public func start(bundleId: String? = nil) throws {
            isStopped = false
            let targetBundleId = bundleId ?? Self.defaultBundleId
            let app = XCUIApplication(bundleIdentifier: targetBundleId)
            app.activate()
            setApplication(app, bundleId: targetBundleId)
            print("[CtrlProxy] Activated app: \(targetBundleId)")

            try server.start()

            print("[CtrlProxy] Service started")
            print("[CtrlProxy] WebSocket server listening on port \(Self.defaultPort)")
            print("[CtrlProxy] Endpoint: ws://localhost:\(Self.defaultPort)/ws")
            print("[CtrlProxy] Health check: http://localhost:\(Self.defaultPort)/health")
            print("[CtrlProxy] Device samplers idle until a client connects")
            print("[CtrlProxy] Ready to accept connections")
        }
    #else
        public func start(bundleId _: String? = nil) throws {
            isStopped = false
            try server.start()
            print("[CtrlProxy] Service started (non-iOS mode - limited functionality)")
        }
    #endif

    /// Stops the service. Sets `isStopped` first so any presence-`true` callback that was queued
    /// onto the main actor while this call blocks inside the synchronous `server.stop()` cannot
    /// restart the samplers once teardown completes (`startSamplers()` guards on it). Closing
    /// connections during teardown also re-enters the presence seam with `false`, calling
    /// `stopSamplers()` again — harmless, since sampler stop is idempotent. Together the
    /// immutable presence closure and this guard replace the reference's "clear the hook first"
    /// teardown step.
    public func stop() {
        isStopped = true
        stopSamplers()
        server.stop()
        print("[CtrlProxy] Service stopped")
    }
}

/// Late-bound weak reference to the coordinator. The server's immutable `@Sendable` seam
/// closures are built during `init`, before `self` exists; they capture this box and read
/// `.coordinator` (set at the end of `init`) once they fire. `@unchecked Sendable`: the box
/// is written once on the main actor during `init` and read only inside `Task { @MainActor }`
/// hops, so all accesses are main-actor-serialized.
private final class WeakCoordinator: @unchecked Sendable {
    weak var coordinator: CtrlProxy?
}

// MARK: - Convenience Extensions

extension CtrlProxy {
    /// Creates and starts a service with default configuration.
    public static func startDefault() throws -> CtrlProxy {
        let service = CtrlProxy()
        try service.start()
        return service
    }

    /// Creates and starts a service for a specific app.
    public static func start(bundleId: String, port: UInt16 = defaultPort) throws -> CtrlProxy {
        let service = CtrlProxy(port: port)
        try service.start(bundleId: bundleId)
        return service
    }
}
