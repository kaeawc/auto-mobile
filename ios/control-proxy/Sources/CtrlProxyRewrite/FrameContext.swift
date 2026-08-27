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

/// Stable, opaque identity for a device hierarchy. A tracker belongs to one CtrlProxy
/// process, so a delayed context can never be reused after that process restarts.
///
/// Lock-confined, NOT an actor: `recordTransition` / `context(for:)` must stay
/// **synchronous** — they are called from the server's off-main broadcast without an
/// `await` (see `FrameContextRecording`) — so the mutable generation counter lives in
/// an `OSAllocatedUnfairLock<UInt64>`, making the type genuinely `Sendable` (the
/// reference guarded a `var generation` with an `NSLock` on a non-`Sendable` class).
/// The generation bump and the current-context read still run inside the main-thread
/// executor, preserving the reference's ordering of a transition against a
/// `performIfCurrent` validation.
final class FrameContext: FrameContextRecording {
    private let epoch: UUID
    private let mainThreadExecutor: any FrameContextMainExecuting
    private let generation = OSAllocatedUnfairLock<UInt64>(initialState: 0)

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
            return generation.withLock { current -> String? in
                current &+= 1
                return hash.map { "\(self.epoch.uuidString):\(current):\($0)" }
            }
        }
    }

    func context(for hierarchy: ViewHierarchy) -> String? {
        let currentGeneration = generation.withLock { $0 }
        return Self.semanticHash(hierarchy).map { "\(epoch.uuidString):\(currentGeneration):\($0)" }
    }

    /// Validates a context and dispatches its gesture on the transition executor.
    func performIfCurrent<T>(
        expected: String?,
        hierarchy: ViewHierarchy?,
        operation: () throws -> T
    ) throws -> T {
        try mainThreadExecutor.perform { [self] in
            guard let expected else { return try operation() }
            guard let hierarchy else {
                throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
            }

            let hash = Self.semanticHash(hierarchy)
            let isCurrent = generation.withLock { current in
                hash.map { "\(self.epoch.uuidString):\(current):\($0)" } == expected
            }

            guard isCurrent else {
                throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
            }
            return try operation()
        }
    }

    private static func semanticHash(_ hierarchy: ViewHierarchy) -> String? {
        // `updatedAt` is assigned for every extraction, so including it would reject an unchanged
        // screen merely because validation sampled it a millisecond later. Hash only semantic
        // screen state, with sorted keys for deterministic dictionary encoding.
        //
        // The reference shared one `JSONEncoder`; the rewrite allocates a fresh encoder per call.
        // `JSONEncoder` is not documented as safe for concurrent `encode(_:)`, and `semanticHash`
        // runs from both the off-main broadcast and gesture validation; a per-call encoder is the
        // genuinely-safe choice and, with `.sortedKeys`, is byte-identical to the reference.
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
