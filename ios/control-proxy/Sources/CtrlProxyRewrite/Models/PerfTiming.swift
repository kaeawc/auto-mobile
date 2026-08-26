import Foundation

/// Performance timing data — hierarchical format matching Android/TypeScript.
/// Embedded in `WebSocketResponse` / `HierarchyUpdateResponse` when present.
public struct PerfTiming: Codable, Sendable {
    public let name: String
    public let durationMs: Int64
    public let children: [PerfTiming]?

    public init(name: String, durationMs: Int64, children: [PerfTiming]? = nil) {
        self.name = name
        self.durationMs = durationMs
        self.children = children
    }

    /// Convenience for creating a simple timing with no children.
    public static func timing(_ name: String, durationMs: Int64) -> PerfTiming {
        PerfTiming(name: name, durationMs: durationMs, children: nil)
    }

    /// Convenience for creating a timing with children.
    public static func timing(_ name: String, durationMs: Int64, children: [PerfTiming]) -> PerfTiming {
        PerfTiming(name: name, durationMs: durationMs, children: children.isEmpty ? nil : children)
    }
}
