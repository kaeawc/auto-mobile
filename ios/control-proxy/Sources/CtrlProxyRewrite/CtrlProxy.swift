import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Concurrency-clean rewrite of the CtrlProxy iOS service (WebDriverAgent-style
/// WebSocket bridge). Coordinates the WebSocket server, element locator, and
/// gesture performer.
///
/// PHASE 0 SCAFFOLD: this recreates the exact external API surface the XCUITest
/// runner uses (`init(port:)`, `start()`, `start(bundleId:)`, `stop()`,
/// `setApplication`, and the `defaultPort` / `defaultBundleId` statics) as
/// behaviour-free no-ops. The real collaborators (server, locator, gesture
/// performer, samplers) are ported in later phases; the no-op shell exists so the
/// target compiles under Swift 6 language mode and the differential parity harness
/// has both `CtrlProxy` (reference) and `CtrlProxyRewrite` modules to link.
///
/// The isolation archetype (this type becomes `@MainActor`, `CommandHandler` a
/// Sendable POD router, the server queue-confined, the SDK relays actors) lands in
/// the phases that give it real behaviour — see the migration plan. Deliberately
/// non-isolated while it holds no state.
public final class CtrlProxy {
    public static let defaultPort: UInt16 = 8765

    private let port: UInt16

    /// Creates the service with the specified port.
    ///
    /// The reference initializer also injects a `Timer` and `StorageInspecting`;
    /// those seams are reintroduced when their collaborators are ported. The
    /// runner only supplies `port`, which is the surface Phase 0 recreates.
    public init(port: UInt16 = defaultPort) {
        self.port = port
    }

    #if canImport(XCTest) && os(iOS)
        /// Default bundle ID to use when none is specified (iOS Springboard/home screen).
        public static let defaultBundleId = "com.apple.springboard"

        /// Sets the application under test with its bundle ID. No-op until the
        /// element locator / gesture performer are ported.
        public func setApplication(_: XCUIApplication, bundleId _: String? = nil) {
            // Phase 0 no-op.
        }

        /// Activates the target application and starts the service. No-op until the
        /// WebSocket server and samplers are ported.
        public func start(bundleId _: String? = nil) throws {
            // Phase 0 no-op.
        }
    #else
        public func start(bundleId _: String? = nil) throws {
            // Phase 0 no-op.
        }
    #endif

    /// Stops the service. No-op until the server/samplers are ported.
    public func stop() {
        // Phase 0 no-op.
    }
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
