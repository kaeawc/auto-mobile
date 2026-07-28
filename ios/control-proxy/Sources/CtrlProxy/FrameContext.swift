import Foundation

/// Stable, opaque identity for a device hierarchy. A tracker belongs to one CtrlProxy process,
/// so a delayed context can never be reused after that process restarts.
public final class FrameContext {
    private let lock = NSLock()
    private let epoch: UUID
    private var generation: UInt64 = 0

    public init(epoch: UUID = UUID()) {
        self.epoch = epoch
    }

    /// Records a device-side UI transition, even when hierarchy publication is debounced.
    public func recordTransition(to _: ViewHierarchy) {
        lock.lock()
        generation &+= 1
        lock.unlock()
    }

    public func context(for hierarchy: ViewHierarchy) -> String? {
        lock.lock()
        let currentGeneration = generation
        lock.unlock()
        return Self.semanticHash(hierarchy).map { "\(epoch.uuidString):\(currentGeneration):\($0)" }
    }

    /// Serializes transition recording with the final context check and gesture dispatch.
    func performIfCurrent<T>(
        expected: String?,
        hierarchy: ViewHierarchy?,
        operation: () throws -> T
    )
        throws -> T
    {
        guard let expected else { return try operation() }
        guard let hierarchy else {
            throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
        }

        lock.lock()
        defer { lock.unlock() }
        guard Self.semanticHash(hierarchy).map({ "\(epoch.uuidString):\(generation):\($0)" }) == expected else {
            throw CommandError.executionFailed("Stale frame context; observe a fresh frame before retrying")
        }
        return try operation()
    }

    private static func semanticHash(_ hierarchy: ViewHierarchy) -> String? {
        // `updatedAt` is assigned for every extraction, so including it would reject an unchanged
        // screen merely because validation sampled it a millisecond later. Hash only semantic
        // screen state, with sorted keys for deterministic dictionary encoding.
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
