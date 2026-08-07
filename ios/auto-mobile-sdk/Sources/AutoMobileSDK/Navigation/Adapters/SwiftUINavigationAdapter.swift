import Foundation
import SwiftUI

/// Adapter for tracking SwiftUI NavigationStack/NavigationPath navigation events.
/// iOS equivalent of Android's Navigation3Adapter.
public final class SwiftUINavigationAdapter: NavigationFrameworkAdapter, @unchecked Sendable {
    public static let shared = SwiftUINavigationAdapter()

    private let lock = NSLock()
    private var _isActive = false

    public var isActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isActive && NavigationAdapterHub.shared.isActive(owner: "swiftui")
    }

    private init() {}

    public func start() {
        NavigationAdapterHub.shared.start(owner: "swiftui")
        lock.lock()
        _isActive = true
        lock.unlock()
    }

    public func stop() {
        NavigationAdapterHub.shared.stop(owner: "swiftui")
        lock.lock()
        _isActive = false
        lock.unlock()
    }

    /// Manually track a navigation event.
    public func trackNavigation(
        destination: String,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) {
        guard isActive else { return }
        NavigationAdapterHub.shared.record(
            owner: "swiftui",
            destination: destination,
            source: .swiftUINavigation,
            identity: NavigationScreenIdentity(route: destination),
            arguments: arguments,
            metadata: metadata
        )
    }

    public func trackSheet(destination: String, sceneIdentifier: String? = nil, metadata: [String: String] = [:]) {
        NavigationAdapterHub.shared.record(owner: "swiftui", destination: destination, source: .swiftUINavigation,
            identity: NavigationScreenIdentity(route: destination), sceneIdentifier: sceneIdentifier,
            metadata: metadata.merging(["transition": "sheet"]) { _, new in new })
    }

    public func trackTab(destination: String, sceneIdentifier: String? = nil) {
        NavigationAdapterHub.shared.record(owner: "swiftui", destination: destination, source: .swiftUINavigation,
            identity: NavigationScreenIdentity(route: destination), sceneIdentifier: sceneIdentifier,
            metadata: ["transition": "tab"])
    }

    public func trackSplitColumn(destination: String, column: String, sceneIdentifier: String? = nil) {
        NavigationAdapterHub.shared.record(owner: "swiftui", destination: destination, source: .swiftUINavigation,
            identity: NavigationScreenIdentity(route: destination), sceneIdentifier: sceneIdentifier,
            metadata: ["transition": "split", "column": column])
    }
}

// MARK: - SwiftUI View Modifier

/// A view modifier that tracks when a SwiftUI destination appears.
public struct TrackNavigationModifier: ViewModifier {
    let destination: String
    let arguments: [String: String]
    let metadata: [String: String]

    public func body(content: Content) -> some View {
        content.onAppear {
            SwiftUINavigationAdapter.shared.trackNavigation(
                destination: destination,
                arguments: arguments,
                metadata: metadata
            )
        }
    }
}

public extension View {
    /// Track navigation to this view using the SwiftUI navigation adapter.
    func trackNavigation(
        destination: String,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) -> some View {
        modifier(TrackNavigationModifier(
            destination: destination,
            arguments: arguments,
            metadata: metadata
        ))
    }
}
