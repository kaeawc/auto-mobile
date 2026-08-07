import Foundation

/// Shared opt-in event sink for adapters that must coexist with host routers.
public final class NavigationAdapterHub: @unchecked Sendable {
    public static let shared = NavigationAdapterHub()

    private let lock = NSLock()
    private var activeOwners: Set<String> = []
    private var _factory = NavigationEventFactory()
    private init() {}

    public var isActive: Bool {
        isActive(owner: nil)
    }

    public func isActive(owner: String?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let owner {
            return activeOwners.contains(owner)
        }
        return !activeOwners.isEmpty
    }

    public func start(owner: String = "default", redactor: any NavigationDataRedacting = NoOpNavigationRedactor()) {
        lock.lock()
        _factory = NavigationEventFactory(redactor: redactor)
        activeOwners.insert(owner)
        lock.unlock()
    }

    public func stop(owner: String = "default") {
        lock.lock(); activeOwners.remove(owner); lock.unlock()
    }

    public func record(
        owner: String = "default",
        destination: String,
        source: NavigationSource,
        identity: NavigationScreenIdentity? = nil,
        sceneIdentifier: String? = nil,
        transitionIdentifier: String? = nil,
        transitionCompleted: Bool = true,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) {
        lock.lock()
        let active = activeOwners.contains(owner)
        let factory = _factory
        lock.unlock()
        guard active, transitionCompleted else { return }
        AutoMobileSDK.shared.notifyNavigationEvent(factory.make(
            destination: destination,
            source: source,
            identity: identity,
            sceneIdentifier: sceneIdentifier,
            transitionIdentifier: transitionIdentifier,
            transitionCompleted: transitionCompleted,
            arguments: arguments,
            metadata: metadata
        ))
    }
}

/// Adapter for routers, universal links, notifications, and state restoration.
public final class DeepLinkNavigationAdapter: NavigationFrameworkAdapter, @unchecked Sendable {
    public static let shared = DeepLinkNavigationAdapter()
    private init() {}
    public var isActive: Bool { NavigationAdapterHub.shared.isActive(owner: "deep_link") }
    public func start() { NavigationAdapterHub.shared.start(owner: "deep_link") }
    public func stop() { NavigationAdapterHub.shared.stop(owner: "deep_link") }

    public func record(
        destination: String,
        identity: NavigationScreenIdentity? = nil,
        sceneIdentifier: String? = nil,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) {
        NavigationAdapterHub.shared.record(
            owner: "deep_link",
            destination: destination, source: .deepLink, identity: identity,
            sceneIdentifier: sceneIdentifier, arguments: arguments, metadata: metadata
        )
    }
}

/// Adapter for application-owned routers that do not use UIKit or SwiftUI.
public final class CustomNavigationAdapter: NavigationFrameworkAdapter, @unchecked Sendable {
    public static let shared = CustomNavigationAdapter()
    private init() {}
    public var isActive: Bool { NavigationAdapterHub.shared.isActive(owner: "custom") }
    public func start() { NavigationAdapterHub.shared.start(owner: "custom") }
    public func stop() { NavigationAdapterHub.shared.stop(owner: "custom") }

    public func record(
        destination: String,
        identity: NavigationScreenIdentity? = nil,
        sceneIdentifier: String? = nil,
        transitionIdentifier: String? = nil,
        transitionCompleted: Bool = true,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) {
        NavigationAdapterHub.shared.record(
            owner: "custom",
            destination: destination, source: .custom, identity: identity,
            sceneIdentifier: sceneIdentifier, transitionIdentifier: transitionIdentifier,
            transitionCompleted: transitionCompleted, arguments: arguments, metadata: metadata
        )
    }
}

#if canImport(UIKit) && !os(watchOS)
import UIKit

/// UIKit lifecycle adapter. Hosts call these hooks from their existing delegates;
/// no global swizzling or delegate replacement is performed.
public final class UIKitNavigationAdapter: NavigationFrameworkAdapter, @unchecked Sendable {
    public static let shared = UIKitNavigationAdapter()
    private init() {}
    public var isActive: Bool { NavigationAdapterHub.shared.isActive(owner: "uikit") }
    public func start() { NavigationAdapterHub.shared.start(owner: "uikit") }
    public func stop() { NavigationAdapterHub.shared.stop(owner: "uikit") }

    public func recordPush(_ viewController: UIViewController, sceneIdentifier: String? = nil, completed: Bool = true) {
        record(viewController, sceneIdentifier: sceneIdentifier, metadata: ["transition": "push"], completed: completed)
    }

    public func recordPop(_ viewController: UIViewController, sceneIdentifier: String? = nil, completed: Bool = true) {
        record(viewController, sceneIdentifier: sceneIdentifier, metadata: ["transition": "pop"], completed: completed)
    }

    public func recordPresentation(_ viewController: UIViewController, sceneIdentifier: String? = nil, completed: Bool = true) {
        record(viewController, sceneIdentifier: sceneIdentifier, metadata: ["transition": "presentation"], completed: completed)
    }

    public func recordTabSelection(_ viewController: UIViewController, sceneIdentifier: String? = nil) {
        record(viewController, sceneIdentifier: sceneIdentifier, metadata: ["transition": "tab"])
    }

    public func recordSplitColumn(_ viewController: UIViewController, column: String, sceneIdentifier: String? = nil) {
        record(viewController, sceneIdentifier: sceneIdentifier, metadata: ["transition": "split", "column": column])
    }

    private func record(
        _ viewController: UIViewController,
        sceneIdentifier: String?,
        metadata: [String: String],
        completed: Bool = true
    ) {
        let destination = String(describing: type(of: viewController))
        NavigationAdapterHub.shared.record(
            owner: "uikit",
            destination: destination,
            source: .uiKitNavigation,
            identity: NavigationScreenIdentity(route: destination),
            sceneIdentifier: sceneIdentifier ?? viewController.viewIfLoaded?.window?.windowScene?.session.persistentIdentifier,
            transitionIdentifier: UUID().uuidString,
            transitionCompleted: completed,
            metadata: metadata
        )
    }
}
#endif
