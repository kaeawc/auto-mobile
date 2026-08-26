import Foundation

public struct ObservationInsetsInfo: Codable, Sendable {
    public let available: Bool
    public let source: String
    public let units: String
    public let safeArea: EdgeInsetsInfo?
    public let systemChrome: SystemChromeInfo?

    public init(
        available: Bool,
        source: String,
        units: String,
        safeArea: EdgeInsetsInfo?,
        systemChrome: SystemChromeInfo?
    ) {
        self.available = available
        self.source = source
        self.units = units
        self.safeArea = safeArea
        self.systemChrome = systemChrome
    }

    public static let unavailable = ObservationInsetsInfo(
        available: false,
        source: "unavailable",
        units: "unknown",
        safeArea: nil,
        systemChrome: nil
    )
}
