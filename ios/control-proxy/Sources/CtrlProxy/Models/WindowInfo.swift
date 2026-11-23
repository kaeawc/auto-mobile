import Foundation

/// Window information.
public struct WindowInfo: Codable, Sendable {
    public let id: Int?
    public let type: Int?
    public let isActive: Bool
    public let isFocused: Bool
    public let bounds: ElementBounds?
    /// Bundle id of the app that owns the window. Omitted for a single-window observation.
    public let packageName: String?

    public init(
        id: Int? = nil,
        type: Int? = nil,
        isActive: Bool = false,
        isFocused: Bool = false,
        bounds: ElementBounds? = nil,
        packageName: String? = nil
    ) {
        self.id = id
        self.type = type
        self.isActive = isActive
        self.isFocused = isFocused
        self.bounds = bounds
        self.packageName = packageName
    }
}
