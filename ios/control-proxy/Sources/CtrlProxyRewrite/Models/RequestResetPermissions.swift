import Foundation

/// Reset privacy authorizations for an app back to not-determined. `bundleId` and
/// `permissions` are decode-required so their absence is rejected at the wire
/// boundary. `permissions=["all"]` expands on the runner. See #2491 and #3133.
public struct RequestResetPermissions: Decodable, Sendable {
    public var requestId: String?
    public var bundleId: String
    public var permissions: [String]

    public init(requestId: String? = nil, bundleId: String, permissions: [String]) {
        self.requestId = requestId
        self.bundleId = bundleId
        self.permissions = permissions
    }
}

extension RequestResetPermissions: CommandPayload {}
