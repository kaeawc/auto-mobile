import Foundation

/// Optional runner capabilities advertised in the `connected` handshake via
/// `ConnectedEvent.supportedFeatures`. Like `supportedCommands`, the daemon reads
/// this to detect runner-version skew, so the raw values are load-bearing wire
/// identifiers — adding, dropping, or renaming a case changes the advertised
/// contract (#5787).
public enum RunnerFeature: String, CaseIterable, Codable, Sendable {
    case displayCutoutInfo = "display_cutout_info"
}
