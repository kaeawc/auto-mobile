import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Main CtrlProxy iOS service that coordinates WebSocket server, element locator, and gesture performer
/// Similar to Appium's WebDriverAgent but matching Android AccessibilityService protocol
public class CtrlProxy {
    public static let defaultPort: UInt16 = 8765

    private let server: WebSocketServer
    private let elementLocator: ElementLocator
    private let gesturePerformer: GesturePerformer
    private let commandHandler: CommandHandler
    private let hierarchyDebouncer: HierarchyDebouncer
    private let fpsMonitor: DisplayLinkFPSMonitor
    private let sdkHierarchyCache: SdkHierarchyCache
    private let frameContext: FrameContext
    private let sdkHierarchyClient: SdkHierarchyClient
    private let sdkDatabaseClient: SdkDatabaseClient
    private let sdkHierarchyRefreshPublisher: SdkHierarchyRefreshPublisher

    #if canImport(XCTest) && os(iOS)
        private var application: XCUIApplication?
    #endif

    /// Creates the service with specified port
    public init(
        port: UInt16 = defaultPort,
        timer: Timer = SystemTimer(),
        storageInspector: StorageInspecting? = DefaultStorageInspecting()
    ) {
        elementLocator = ElementLocator()
        gesturePerformer = GesturePerformer(elementLocator: elementLocator)
        frameContext = FrameContext()
        sdkHierarchyCache = SdkHierarchyCache()
        sdkHierarchyClient = SdkHierarchyClient()
        sdkDatabaseClient = SdkDatabaseClient()
        hierarchyDebouncer = HierarchyDebouncer(elementLocator: elementLocator, timer: timer)
        commandHandler = CommandHandler(
            elementLocator: elementLocator,
            gesturePerformer: gesturePerformer,
            storageInspector: storageInspector,
            sdkHierarchyClient: sdkHierarchyClient,
            sdkHierarchyCache: sdkHierarchyCache,
            sdkDatabaseClient: sdkDatabaseClient,
            hierarchyDebouncer: hierarchyDebouncer,
            frameContext: frameContext
        )
        server = WebSocketServer(
            port: port,
            commandHandler: commandHandler,
            sdkHierarchyCache: sdkHierarchyCache,
            frameContext: frameContext
        )
        fpsMonitor = DisplayLinkFPSMonitor()
        sdkHierarchyRefreshPublisher = SdkHierarchyRefreshPublisher(
            hierarchyProvider: { [weak hierarchyDebouncer] in
                hierarchyDebouncer?.getLastHierarchy()
            },
            enrich: { [weak commandHandler] hierarchy in
                commandHandler?.enrichWithCachedSdkHierarchy(hierarchy) ?? hierarchy
            },
            broadcast: { [weak server] hierarchy in
                server?.broadcastHierarchyUpdate(hierarchy)
            }
        )
        server.onSdkHierarchyUpdated = { [weak self] in
            self?.sdkHierarchyRefreshPublisher.publish()
        }
        hierarchyDebouncer.setOnTransition { [weak self] hierarchy in
            self?.frameContext.recordTransition(to: hierarchy)
        }
    }

    #if canImport(XCTest) && os(iOS)
        /// Default bundle ID to use when none is specified (iOS Springboard/home screen)
        public static let defaultBundleId = "com.apple.springboard"

        /// Sets the application under test with its bundle ID
        public func setApplication(_ app: XCUIApplication, bundleId: String? = nil) {
            application = app
            if let bundleId = bundleId {
                elementLocator.setApplication(app, bundleId: bundleId)
            } else {
                elementLocator.setApplication(app)
            }
            gesturePerformer.setApplication(app)
        }

        /// Activates the target application and starts the service
        public func start(bundleId: String? = nil) throws {
            // Activate or connect to target app
            // Use provided bundleId, or default to Springboard (home screen)
            let targetBundleId = bundleId ?? Self.defaultBundleId
            let app = XCUIApplication(bundleIdentifier: targetBundleId)
            app.activate()
            setApplication(app, bundleId: targetBundleId)
            print("[CtrlProxy] Activated app: \(targetBundleId)")

            // Start the server
            try server.start()

            // Wire up hierarchy debouncer to broadcast updates when content changes.
            // The result callback is installed once; the debouncer itself is only
            // started while a client is connected (see gating below).
            hierarchyDebouncer.setOnResult { [weak self] result in
                switch result {
                case let .changed(hierarchy, hash, extractionTimeMs):
                    print(
                        "[CtrlProxy] Hierarchy changed (hash=\(hash), extraction=\(extractionTimeMs)ms), broadcasting"
                    )
                    guard let self else { return }
                    let enriched = self.commandHandler.enrichWithCachedSdkHierarchy(hierarchy)
                    self.server.broadcastHierarchyUpdate(enriched)
                case .unchanged:
                    // Don't broadcast unchanged results (animation mode)
                    break
                case let .error(message):
                    print("[CtrlProxy] Hierarchy extraction error: \(message)")
                }
            }

            // Gate the always-on device samplers (hierarchy debouncer, OSLog poll,
            // CADisplayLink FPS monitor) on client presence: they start on the first
            // connected client and stop on the last disconnect, so an idle session
            // with no client places no continuous load on the app under test
            // (issue #5477). Sampler start/stop is hopped to the main queue so the
            // presence callback never blocks the server queue with a hierarchy walk.
            server.onClientPresenceChanged = { [weak self] hasClients in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if hasClients {
                        self.startSamplers()
                    } else {
                        self.stopSamplers()
                    }
                }
            }

            print("[CtrlProxy] Service started")
            print("[CtrlProxy] WebSocket server listening on port \(Self.defaultPort)")
            print("[CtrlProxy] Endpoint: ws://localhost:\(Self.defaultPort)/ws")
            print("[CtrlProxy] Health check: http://localhost:\(Self.defaultPort)/health")
            print("[CtrlProxy] Device samplers idle until a client connects")
            print("[CtrlProxy] Ready to accept connections")
        }
    #endif

    #if canImport(XCTest) && os(iOS)
        /// Starts the device-side samplers. Called when the first client connects.
        /// All three start operations are idempotent.
        private func startSamplers() {
            hierarchyDebouncer.start()

            if #available(iOS 15.0, *) {
                OSLogReaderHolder.shared.start()
                print("[CtrlProxy] OSLogReader active (polling every \(OSLogReader.pollIntervalMs)ms)")
            }

            fpsMonitor.startMonitoring { [weak self] snapshot in
                self?.server.broadcastPerformanceUpdate(snapshot)
            }

            print(
                "[CtrlProxy] Hierarchy debouncer active (polling every \(HierarchyDebouncer.defaultPollIntervalMs)ms)"
            )
            print(
                "[CtrlProxy] FPS monitor active (reporting every \(DisplayLinkFPSMonitor.defaultReportIntervalSeconds)s)"
            )
        }

        /// Stops the device-side samplers. Called when the last client disconnects.
        private func stopSamplers() {
            if #available(iOS 15.0, *) {
                OSLogReaderHolder.shared.stop()
            }
            fpsMonitor.stopMonitoring()
            hierarchyDebouncer.stop()
            print("[CtrlProxy] Device samplers paused (no clients connected)")
        }
    #else
        public func start(bundleId _: String? = nil) throws {
            try server.start()
            print("[CtrlProxy] Service started (non-iOS mode - limited functionality)")
        }
    #endif

    /// Stops the service
    public func stop() {
        // Clear the presence hook first so closing connections during teardown does
        // not re-enter the sampler start/stop path.
        server.onClientPresenceChanged = nil
        if #available(iOS 15.0, *) {
            OSLogReaderHolder.shared.stop()
        }
        fpsMonitor.stopMonitoring()
        hierarchyDebouncer.stop()
        server.stop()
        print("[CtrlProxy] Service stopped")
    }
}

// MARK: - Convenience Extensions

extension CtrlProxy {
    /// Creates and starts a service with default configuration
    public static func startDefault() throws -> CtrlProxy {
        let service = CtrlProxy()
        try service.start()
        return service
    }

    /// Creates and starts a service for a specific app
    public static func start(bundleId: String, port: UInt16 = defaultPort) throws -> CtrlProxy {
        let service = CtrlProxy(port: port)
        try service.start(bundleId: bundleId)
        return service
    }
}
