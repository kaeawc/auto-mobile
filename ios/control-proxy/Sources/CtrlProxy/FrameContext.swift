import Foundation
import os

/// Seam for running the transition/validation body on the main thread. Injectable so
/// tests can substitute a synchronous executor. `Sendable` so `FrameContext` (which
/// stores one) stays `Sendable`.
protocol FrameContextMainExecuting: Sendable {
    func perform<T>(_ operation: () throws -> T) throws -> T
}

/// Production executor: hops to the main thread (via `runOnMainThread`, which also
/// catches ObjC exceptions). Stateless → genuinely `Sendable`.
private struct MainThreadFrameContextExecutor: FrameContextMainExecuting {
    func perform<T>(_ operation: () throws -> T) throws -> T {
        try withoutActuallyEscaping(operation) { operation in
            try runOnMainThread(operation)
        }
    }
}

final class FrameContext: FrameContextRecording {
    private struct State {
        var generation: UInt64 = 0
        var lastHash: String?
    }

    private let epoch: UUID
    private let mainThreadExecutor: any FrameContextMainExecuting
    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    init(epoch: UUID = UUID()) {
        self.epoch = epoch
        mainThreadExecutor = MainThreadFrameContextExecutor()
    }

    init(epoch: UUID, mainThreadExecutor: any FrameContextMainExecuting) {
        self.epoch = epoch
        self.mainThreadExecutor = mainThreadExecutor
    }

    /// Records a device-side UI transition and returns the context for that exact generation.
    @discardableResult
    func recordTransition(to hierarchy: ViewHierarchy) -> String? {
        try? mainThreadExecutor.perform { [self] in
            let hash = Self.semanticHash(hierarchy)
            return state.withLock { current -> String? in
                // A missing hash cannot establish equality with the previous transition.
                if hash == nil || hash != current.lastHash {
                    current.generation &+= 1
                    current.lastHash = hash
                }
                return hash.map { "\(self.epoch.uuidString):\(current.generation):\($0)" }
            }
        }
    }

    func context(for hierarchy: ViewHierarchy) -> String? {
        let currentGeneration = state.withLock { $0.generation }
        return Self.semanticHash(hierarchy).map { "\(epoch.uuidString):\(currentGeneration):\($0)" }
    }

    /// Validates a context and dispatches its gesture on the transition executor.
    func performIfCurrent<T>(
        expected: String?,
        hierarchy: ViewHierarchy?,
        operation: () throws -> T
    )
        throws -> T
    {
        try mainThreadExecutor.perform { [self] in
            guard let expected else { return try operation() }
            guard let hierarchy else {
                throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
            }

            let hash = Self.semanticHash(hierarchy)
            let isCurrent = state.withLock { current in
                hash.map { "\(self.epoch.uuidString):\(current.generation):\($0)" } == expected
            }

            guard isCurrent else {
                throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
            }
            return try operation()
        }
    }

    private static func semanticHash(_ hierarchy: ViewHierarchy) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(SemanticHierarchy(hierarchy)) else { return nil }
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in data {
            hash ^= UInt64(byte)
            hash &*= 0x1000_0000_01B3
        }
        return String(hash, radix: 16)
    }
}

private struct SemanticHierarchy: Encodable {
    let packageName: String?
    let hierarchy: UIElementInfo?
    let windowInfo: WindowInfo?
    let windows: [WindowInfo]?
    let screenScale: Float?
    let screenWidth: Int?
    let screenHeight: Int?
    let systemInsets: EdgeInsetsInfo?
    let insets: ObservationInsetsInfo
    let error: String?
    let fallbackToSpringboard: Bool?

    init(_ value: ViewHierarchy) {
        packageName = value.packageName
        hierarchy = value.hierarchy
        windowInfo = value.windowInfo
        windows = value.windows
        screenScale = value.screenScale
        screenWidth = value.screenWidth
        screenHeight = value.screenHeight
        systemInsets = value.systemInsets
        insets = value.insets
        error = value.error
        fallbackToSpringboard = value.fallbackToSpringboard
    }
}
