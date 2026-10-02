import Foundation
import os
import SwiftUI

/// Adapter for tracking SwiftUI NavigationStack/NavigationPath navigation events.
/// iOS equivalent of Android's Navigation3Adapter.
public final class SwiftUINavigationAdapter: NavigationFrameworkAdapter, Sendable {
    public static let shared = SwiftUINavigationAdapter()

    private let active = OSAllocatedUnfairLock(initialState: false)

    public var isActive: Bool {
        active.withLock { $0 && NavigationAdapterHub.shared.isActive(owner: "swiftui") }
    }

    private init() {}

    public func start() {
        NavigationAdapterHub.shared.start(owner: "swiftui")
        active.withLock { $0 = true }
    }

    public func stop() {
        NavigationAdapterHub.shared.stop(owner: "swiftui")
        active.withLock { $0 = false }
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
        NavigationAdapterHub.shared.record(
            owner: "swiftui",
            destination: destination,
            source: .swiftUINavigation,
            identity: NavigationScreenIdentity(route: destination),
            sceneIdentifier: sceneIdentifier,
            metadata: metadata.merging(["transition": "sheet"]) { _, new in new }
        )
    }

    public func trackTab(destination: String, sceneIdentifier: String? = nil) {
        NavigationAdapterHub.shared.record(
            owner: "swiftui",
            destination: destination,
            source: .swiftUINavigation,
            identity: NavigationScreenIdentity(route: destination),
            sceneIdentifier: sceneIdentifier,
            metadata: ["transition": "tab"]
        )
    }

    public func trackSplitColumn(destination: String, column: String, sceneIdentifier: String? = nil) {
        NavigationAdapterHub.shared.record(
            owner: "swiftui",
            destination: destination,
            source: .swiftUINavigation,
            identity: NavigationScreenIdentity(route: destination),
            sceneIdentifier: sceneIdentifier,
            metadata: ["transition": "split", "column": column]
        )
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

extension View {
    /// Track navigation to this view using the SwiftUI navigation adapter.
    public func trackNavigation(
        destination: String,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    )
        -> some View
    {
        modifier(TrackNavigationModifier(
            destination: destination,
            arguments: arguments,
            metadata: metadata
        ))
    }
}
