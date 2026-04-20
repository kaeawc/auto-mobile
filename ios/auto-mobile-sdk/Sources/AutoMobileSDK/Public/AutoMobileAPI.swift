import Foundation

/// Core public API for the AutoMobile SDK.
/// Enables dependency injection with any DI framework.
public protocol AutoMobileAPI: AnyObject, Sendable {

    // MARK: - Lifecycle
    func initialize()
    func initialize(configuration: AutoMobileConfiguration)
    func shutdown()

    // MARK: - Enable/Disable
    var isEnabled: Bool { get }
    func setEnabled(_ enabled: Bool)
    var isInitialized: Bool { get }

    // MARK: - Navigation
    func addNavigationListener(_ listener: NavigationListener)
    @discardableResult
    func addNavigationListener(_ block: @escaping @Sendable (NavigationEvent) -> Void) -> NavigationListener
    func removeNavigationListener(_ listener: NavigationListener)
    func clearNavigationListeners()
    func notifyNavigationEvent(_ event: NavigationEvent)
    var listenerCount: Int { get }

    // MARK: - Session
    func currentSessionId() -> String?

    // MARK: - Breadcrumbs & Context
    func addBreadcrumb(message: String, category: BreadcrumbCategory, metadata: [String: String])
    func setUserId(_ userId: String?)
    func setTag(_ key: String, value: String)
    func removeTag(_ key: String)

    // MARK: - Status
    var configuration: AutoMobileConfiguration? { get }
    var bundleId: String? { get }
    var dropReport: [DropReason: Int] { get }
}
