import Foundation

/// The JSON contract between the AutoMobile daemon and `network-filter-controller`.
///
/// The daemon runs the installed controller as a subprocess and parses the one
/// line of JSON it prints. Bump `version` whenever a field changes meaning or a
/// required field is added or removed; the daemon rejects any other version.
/// The nested `snapshot` carries the provider's own version. Version 2 is the
/// first published contract: it ships with per-simulator attribution (#10589),
/// where `status` and `snapshot` take repeatable `--managed <device-set> <udid>`
/// pairs. There is no version 1 fallback.
public enum ControllerContract {
    public static let version = 2
    public static let commands = ["activate", "status", "snapshot"]
}

/// Every state the controller reports. The raw values are the wire format.
public enum ControllerState: String, Codable, CaseIterable {
    /// The app or provider is not signed and provisioned, or not run from /Applications.
    case installationRequired = "installation_required"
    /// The system extension or filter configuration waits for approval, or a restart.
    case approvalRequired = "approval_required"
    /// Activation or the authenticated read-back failed or timed out.
    case unavailable
    /// The allow-only provider replied over authenticated XPC.
    case ready
}

public struct ControllerResult: Codable {
    public let version: Int
    public let state: ControllerState
    public let detail: String
    public let snapshot: ProbeSnapshot?

    public init(
        state: ControllerState,
        detail: String,
        snapshot: ProbeSnapshot? = nil,
        version: Int = ControllerContract.version
    ) {
        self.version = version
        self.state = state
        self.detail = detail
        self.snapshot = snapshot
    }

    /// One line of JSON, without the trailing newline the controller writes.
    public func encodedLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
}
