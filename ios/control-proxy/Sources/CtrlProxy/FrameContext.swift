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
        /// Per-field hashes behind the contexts most recently handed to the host, newest last, so a
        /// stale-context rejection can name what changed (#19169).
        var issued: [(context: String, hierarchy: ViewHierarchy)] = []
    }

    private static let issuedLimit = 8

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
                let context = hash.map { "\(self.epoch.uuidString):\(current.generation):\($0)" }
                if let context { Self.remember(context, hierarchy, in: &current) }
                return context
            }
        }
    }

    func context(for hierarchy: ViewHierarchy) -> String? {
        let currentGeneration = state.withLock { $0.generation }
        return Self.semanticHash(hierarchy).map { "\(epoch.uuidString):\(currentGeneration):\($0)" }
    }

    /// The context for `hierarchy`, remembered as handed to the host (an observe response).
    func issueContext(for hierarchy: ViewHierarchy) -> String? {
        let hash = Self.semanticHash(hierarchy)
        return state.withLock { current -> String? in
            guard let hash else { return nil }
            let context = "\(epoch.uuidString):\(current.generation):\(hash)"
            Self.remember(context, hierarchy, in: &current)
            return context
        }
    }

    /// Why `expected` does not match the context of `hierarchy`, for the stale-context log line:
    /// a restarted runner, a newer generation, and which semantic fields differ from the hierarchy
    /// `expected` was issued for, when it is one of the last few issued.
    func staleReason(expected: String, hierarchy: ViewHierarchy) -> String {
        let actual = context(for: hierarchy) ?? "unhashable"
        let expectedParts = expected.split(separator: ":", omittingEmptySubsequences: false)
        let actualParts = actual.split(separator: ":", omittingEmptySubsequences: false)
        guard expectedParts.count == 3, actualParts.count == 3 else {
            return "expected \(expected), current \(actual)"
        }
        if expectedParts[0] != actualParts[0] {
            return "the context is from another runner session (epoch \(expectedParts[0]))"
        }
        var reasons: [String] = []
        if expectedParts[1] != actualParts[1] {
            reasons.append("generation \(expectedParts[1]) -> \(actualParts[1])")
        }
        if expectedParts[2] != actualParts[2] {
            let issued = state.withLock { current in current.issued.last { $0.context == expected }?.hierarchy }
            if let issued {
                let before = Self.fieldHashes(issued)
                let now = Self.fieldHashes(hierarchy)
                let changed = Set(before.keys).union(now.keys).sorted().filter { before[$0] != now[$0] }
                reasons.append("changed fields [\(changed.joined(separator: ", "))]")
                if let difference = Self.firstDifference(issued.hierarchy, hierarchy.hierarchy, path: "hierarchy") {
                    reasons.append(difference)
                }
            } else {
                reasons.append("semantic hash \(expectedParts[2]) -> \(actualParts[2]) (issued hierarchy not retained)")
            }
        }
        return reasons.isEmpty ? "contexts match" : reasons.joined(separator: "; ")
    }

    private static func remember(_ context: String, _ hierarchy: ViewHierarchy, in state: inout State) {
        state.issued.removeAll { $0.context == context }
        state.issued.append((context, hierarchy))
        if state.issued.count > issuedLimit {
            state.issued.removeFirst(state.issued.count - issuedLimit)
        }
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
        hash(SemanticHierarchy(hierarchy))
    }

    private static func hash(_ value: some Encodable) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(value) else { return nil }
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in data {
            hash ^= UInt64(byte)
            hash &*= 0x1000_0000_01B3
        }
        return String(hash, radix: 16)
    }

    /// The first element whose own fields or child count differ, depth first, with both sides'
    /// own fields (truncated), so a log line shows what moved between two captures.
    static func firstDifference(_ lhs: UIElementInfo?, _ rhs: UIElementInfo?, path: String) -> String? {
        let left = lhs.flatMap(ownFieldsJSON)
        let right = rhs.flatMap(ownFieldsJSON)
        let leftChildren = lhs?.node ?? []
        let rightChildren = rhs?.node ?? []
        if left != right {
            return "first difference at \(path): \(truncated(left)) -> \(truncated(right))"
        }
        if leftChildren.count != rightChildren.count {
            return "first difference at \(path): children \(summary(leftChildren)) -> \(summary(rightChildren))"
        }
        for (index, pair) in zip(leftChildren, rightChildren).enumerated() {
            if let found = firstDifference(pair.0, pair.1, path: "\(path).node[\(index)]") {
                return found
            }
        }
        return nil
    }

    /// Each child's class, label and bounds, enough to tell which elements one capture lacks.
    private static func summary(_ children: [UIElementInfo]) -> String {
        let items = children.map { child -> String in
            let label = child.text ?? child.contentDesc ?? child.resourceId ?? ""
            let bounds = child.bounds.map { "\($0.left),\($0.top),\($0.right),\($0.bottom)" } ?? "?"
            return "\(child.className ?? "?")'\(label)'@\(bounds)"
        }
        return truncated("[\(items.joined(separator: " | "))]")
    }

    private static func truncated(_ text: String?) -> String {
        guard let text else { return "nil" }
        return text.count > 600 ? "\(text.prefix(600))…" : text
    }

    private static func ownFieldsJSON(_ element: UIElementInfo) -> String? {
        guard let data = try? JSONEncoder().encode(element),
              var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        object.removeValue(forKey: "node")
        guard let flat = try? JSONSerialization.data(withJSONObject: object, options: .sortedKeys) else {
            return nil
        }
        return String(data: flat, encoding: .utf8)
    }

    /// The element's own fields, without its `node` subtrees.
    private static func hashWithoutChildren(_ element: UIElementInfo) -> String? {
        ownFieldsJSON(element).flatMap(hash)
    }

    /// One hash per `SemanticHierarchy` field; `hierarchy` is split per top-level child so a
    /// diff can point at the subtree that changed.
    static func fieldHashes(_ value: ViewHierarchy) -> [String: String] {
        let semantic = SemanticHierarchy(value)
        var fields: [String: String?] = [:]
        fields = [
            "packageName": hash(semantic.packageName),
            "windowInfo": hash(semantic.windowInfo),
            "windows": hash(semantic.windows),
            "screen": hash([semantic.screenWidth, semantic.screenHeight]),
            "screenScale": hash(semantic.screenScale),
            "systemInsets": hash(semantic.systemInsets),
            "insets": hash(semantic.insets),
            "error": hash(semantic.error),
            "fallbackToSpringboard": hash(semantic.fallbackToSpringboard),
            "hierarchy.root": semantic.hierarchy.flatMap(hashWithoutChildren),
        ]
        for (index, child) in (semantic.hierarchy?.node ?? []).enumerated() {
            fields["hierarchy.node[\(index)]"] = hash(child)
        }
        return fields.compactMapValues { $0 }
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
