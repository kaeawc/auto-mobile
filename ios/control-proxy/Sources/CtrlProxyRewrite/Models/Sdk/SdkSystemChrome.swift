import Foundation

public struct SdkSystemChrome: Codable, Sendable {
    public let visibility: String
    public let statusBar: String
    public let homeIndicatorAutoHideRequested: Bool?
    public let source: String

    public init(
        visibility: String,
        statusBar: String,
        homeIndicatorAutoHideRequested: Bool? = nil,
        source: String
    ) {
        self.visibility = visibility
        self.statusBar = statusBar
        self.homeIndicatorAutoHideRequested = homeIndicatorAutoHideRequested
        self.source = source
    }
}
