import AutoMobileSdkWire
import Foundation
import os

/// The declaration order is the host-integration capability matrix order.
enum HostIntegrationFamily: String, CaseIterable, Sendable {
    case wkWebView = "webview.wkwebview"
    case uiKit = "navigation.uikit"
    case swiftUI = "navigation.swiftui"
    case deepLink = "navigation.deeplink"
    case custom = "navigation.custom"
}

final class HostIntegrationRegistry: Sendable {
    private let registered = OSAllocatedUnfairLock(initialState: Set<HostIntegrationFamily>())

    func register(_ family: HostIntegrationFamily) {
        registered.withLock { _ = $0.insert(family) }
    }

    func reset() {
        registered.withLock { $0.removeAll() }
    }

    func descriptors(initialized: Bool) -> [SdkCapabilityDescriptor] {
        let snapshot = registered.withLock { $0 }
        return HostIntegrationFamily.allCases.map { family in
            let active = snapshot.contains(family)
            return SdkCapabilityDescriptor(
                id: family.rawValue,
                state: !initialized ? .notInitialized : active ? .supported : .disabled,
                reason: !initialized ? "NOT_INITIALIZED" : active ? nil : "HOST_OPT_IN",
                faultEnforcement: .notEnforceable,
                faultActions: []
            )
        }
    }
}

/// Explicit host opt-in for navigation capture. Hosts retain their delegates and URL dispatch.
/// Register the families you forward; starting the SDK alone does not activate them.
public final class AutoMobileNavigation: Sendable {
    public static let shared = AutoMobileNavigation(sdk: .shared)
    let hostIntegrations = HostIntegrationRegistry()
    private let sdk: AutoMobileSDK

    init(sdk: AutoMobileSDK) {
        self.sdk = sdk
    }

    #if canImport(UIKit) && !os(watchOS)
        /// Register UIKit hooks. Forward completed push, pop, presentation, tab and split callbacks
        /// from your existing delegates to the returned adapter.
        @discardableResult
        public func registerUIKit() -> UIKitNavigationAdapter {
            let adapter = UIKitNavigationAdapter.shared
            adapter.start()
            hostIntegrations.register(.uiKit)
            return adapter
        }
    #endif

    /// Register SwiftUI capture, then use `.trackNavigation()` or the adapter's `track*` calls.
    @discardableResult
    public func registerSwiftUI() -> SwiftUINavigationAdapter {
        let adapter = SwiftUINavigationAdapter.shared
        adapter.start()
        hostIntegrations.register(.swiftUI)
        return adapter
    }

    /// Register deep links, then call `record` from your URL handler. URL dispatch stays yours.
    @discardableResult
    public func registerDeepLinks() -> DeepLinkNavigationAdapter {
        let adapter = DeepLinkNavigationAdapter.shared
        adapter.start()
        hostIntegrations.register(.deepLink)
        return adapter
    }

    /// Register an application router, then call `record` for each completed transition.
    @discardableResult
    public func registerCustomRouter() -> CustomNavigationAdapter {
        let adapter = CustomNavigationAdapter.shared
        adapter.start()
        hostIntegrations.register(.custom)
        return adapter
    }

    /// WKWebView, UIKit, SwiftUI, deep-link and custom-router descriptors, in that order.
    /// Missing registration is `DISABLED/HOST_OPT_IN`. A stopped or disabled SDK reports
    /// `NOT_INITIALIZED`. Registration attests host forwarding, not automatic coverage.
    public func hostIntegrationCapabilities() -> [SdkCapabilityDescriptor] {
        hostIntegrations.descriptors(initialized: sdk.isInitialized && sdk.isEnabled)
    }

    func reset() {
        hostIntegrations.reset()
        SwiftUINavigationAdapter.shared.stop()
        DeepLinkNavigationAdapter.shared.stop()
        CustomNavigationAdapter.shared.stop()
        #if canImport(UIKit) && !os(watchOS)
            UIKitNavigationAdapter.shared.stop()
        #endif
    }
}
