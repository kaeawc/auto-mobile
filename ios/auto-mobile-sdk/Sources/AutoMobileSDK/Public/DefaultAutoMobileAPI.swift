import Foundation

/// Default implementation of `AutoMobileAPI` backed by `AutoMobileSDK.shared`.
public final class DefaultAutoMobileAPI: AutoMobileAPI, @unchecked Sendable {
    private let sdk = AutoMobileSDK.shared

    public init() {}

    // MARK: - Lifecycle

    public func initialize() {
        sdk.initialize()
    }

    public func initialize(configuration: AutoMobileConfiguration) {
        sdk.initialize(configuration: configuration)
    }

    public func shutdown() {
        sdk.shutdown()
    }

    // MARK: - Enable/Disable

    public var isEnabled: Bool { sdk.isEnabled }

    public func setEnabled(_ enabled: Bool) {
        sdk.setEnabled(enabled)
    }

    public var isInitialized: Bool { sdk.isInitialized }

    // MARK: - Navigation

    public func addNavigationListener(_ listener: NavigationListener) {
        sdk.addNavigationListener(listener)
    }

    @discardableResult
    public func addNavigationListener(_ block: @escaping @Sendable (NavigationEvent) -> Void) -> NavigationListener {
        sdk.addNavigationListener(block)
    }

    public func removeNavigationListener(_ listener: NavigationListener) {
        sdk.removeNavigationListener(listener)
    }

    public func clearNavigationListeners() {
        sdk.clearNavigationListeners()
    }

    public func notifyNavigationEvent(_ event: NavigationEvent) {
        sdk.notifyNavigationEvent(event)
    }

    public var listenerCount: Int { sdk.listenerCount }

    // MARK: - Session

    public func currentSessionId() -> String? {
        sdk.currentSessionId()
    }

    // MARK: - Breadcrumbs & Context

    public func addBreadcrumb(message: String, category: BreadcrumbCategory, metadata: [String: String]) {
        sdk.addBreadcrumb(message: message, category: category, metadata: metadata)
    }

    public func setUserId(_ userId: String?) {
        sdk.setUserId(userId)
    }

    public func setTag(_ key: String, value: String) {
        sdk.setTag(key, value: value)
    }

    public func removeTag(_ key: String) {
        sdk.removeTag(key)
    }

    // MARK: - Status

    public var configuration: AutoMobileConfiguration? { sdk.configuration }
    public var bundleId: String? { sdk.bundleId }
    public var dropReport: [DropReason: Int] { sdk.dropReport }
}
