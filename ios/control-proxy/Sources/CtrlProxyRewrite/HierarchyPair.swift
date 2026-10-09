import Foundation

/// On-disk shape of one recorded merger input pair.
public struct HierarchyPair: Codable, Sendable {
    public let xcuitest: ViewHierarchy
    public let sdk: SdkViewHierarchy

    public init(xcuitest: ViewHierarchy, sdk: SdkViewHierarchy) {
        self.xcuitest = xcuitest
        self.sdk = sdk
    }
}
