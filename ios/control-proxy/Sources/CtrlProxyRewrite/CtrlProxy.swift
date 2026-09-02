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

    #if canImport(XCTest) && os(iOS)
        private var application: XCUIApplication?
    #endif

    /// Creates the service with the specified port.
    ///
    /// The reference also injected a `Timer`; that seam is dropped here because the rewrite's
    /// `ProxyTimer`/`SystemTimer` are internal (a public init cannot expose them) and the
    /// coordinator has no unit tests that need to substitute one — `HierarchyDebouncer`
    /// defaults its own `SystemTimer`.
    public init(
        port: UInt16 = defaultPort,
        storageInspector: (any StorageInspecting)? = DefaultStorageInspecting()
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
        let hierarchyDebouncer = HierarchyDebouncer(hierarchyExtractor: elementLocator, perf: perf)
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
                    guard let coordinator = coordinatorBox.coordinator else { return }
                    if hasClients {
                        coordinator.startSamplers()
                    } else {
                        coordinator.stopSamplers()
                    }
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

    /// Starts the device-side samplers when the first client connects. All three starts are
    /// idempotent. Cross-platform: `DisplayLinkFPSMonitor` / `OSLogReaderHolder` no-op where
    /// their platform APIs are unavailable.
    private func startSamplers() {
        hierarchyDebouncer.start()
        OSLogReaderHolder.shared.start()
        fpsMonitor.startMonitoring { [weak self] snapshot in
            self?.server.broadcastPerformanceUpdate(snapshot)
        }
        print("[CtrlProxy] Device samplers active (hierarchy debouncer, OSLog reader, FPS monitor)")
    }

    /// Stops the device-side samplers when the last client disconnects.
    private func stopSamplers() {
        OSLogReaderHolder.shared.stop()
        fpsMonitor.stopMonitoring()
        hierarchyDebouncer.stop()
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
            try server.start()
            print("[CtrlProxy] Service started (non-iOS mode - limited functionality)")
        }
    #endif

    /// Stops the service. Closing connections during teardown re-enters the presence seam,
    /// which hops to the main actor to call `stopSamplers()` again — harmless, since sampler
    /// stop is idempotent (so the reference's "clear the hook first" guard is unnecessary now
    /// that the hook is an immutable closure).
    public func stop() {
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
