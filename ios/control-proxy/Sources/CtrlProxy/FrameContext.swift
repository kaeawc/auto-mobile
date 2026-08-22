import Foundation

protocol FrameContextMainExecuting: AnyObject {
    func perform<T>(_ operation: () throws -> T) throws -> T
}

private final class MainThreadFrameContextExecutor: FrameContextMainExecuting {
    func perform<T>(_ operation: () throws -> T) throws -> T {
        try withoutActuallyEscaping(operation) { operation in
            try runOnMainThread(operation)
        }
    }
}

/// Stable, opaque identity for a device hierarchy. A tracker belongs to one CtrlProxy process,
/// so a delayed context can never be reused after that process restarts.
public final class FrameContext {
    private let lock = NSLock()
    private let epoch: UUID
    private let mainThreadExecutor: FrameContextMainExecuting
    private var generation: UInt64 = 0

    public init(epoch: UUID = UUID()) {
        self.epoch = epoch
        mainThreadExecutor = MainThreadFrameContextExecutor()
    }

    init(epoch: UUID, mainThreadExecutor: FrameContextMainExecuting) {
        self.epoch = epoch
        self.mainThreadExecutor = mainThreadExecutor
    }

    /// Records a device-side UI transition and returns the context for that exact generation.
    @discardableResult
    public func recordTransition(to hierarchy: ViewHierarchy) -> String? {
        try? mainThreadExecutor.perform { [self] in
            let hash = Self.semanticHash(hierarchy)
            self.lock.lock()
            self.generation &+= 1
            let context = hash.map { "\(self.epoch.uuidString):\(self.generation):\($0)" }
            self.lock.unlock()
            return context
        }
    }

    public func context(for hierarchy: ViewHierarchy) -> String? {
        lock.lock()
        let currentGeneration = generation
        lock.unlock()
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
            self.lock.lock()
            let isCurrent = hash.map { "\(self.epoch.uuidString):\(self.generation):\($0)" } == expected
            self.lock.unlock()

            guard isCurrent else {
                throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
            }
            return try operation()
        }
    }

    /// Shared encoder for `semanticHash`. `.outputFormatting` is set once and never mutated
    /// afterward, so read-only `encode(_:)` calls are safe to share; this avoids allocating a
    /// fresh `JSONEncoder` on every hash (one per gesture validation and screenshot pairing).
    private static let semanticHashEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return encoder
    }()

    private static func semanticHash(_ hierarchy: ViewHierarchy) -> String? {
        // `updatedAt` is assigned for every extraction, so including it would reject an unchanged
        // screen merely because validation sampled it a millisecond later. Hash only semantic
        // screen state, with sorted keys for deterministic dictionary encoding.
        guard let data = try? semanticHashEncoder.encode(SemanticHierarchy(hierarchy)) else { return nil }
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
