import Foundation

public struct SystemChromeInfo: Codable, Sendable {
    public let visibility: String
    public let statusBar: String
    public let navigationBar: String?
    public let homeIndicatorAutoHideRequested: Bool?
    public let source: String

    public init(
        visibility: String,
        statusBar: String,
        navigationBar: String? = nil,
        homeIndicatorAutoHideRequested: Bool? = nil,
        source: String
    ) {
        self.visibility = visibility
        self.statusBar = statusBar
        self.navigationBar = navigationBar
        self.homeIndicatorAutoHideRequested = homeIndicatorAutoHideRequested
        self.source = source
    }
}
