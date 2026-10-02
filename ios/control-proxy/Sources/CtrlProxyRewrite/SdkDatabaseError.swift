import Foundation

/// Errors surfaced when relaying database inspection to the in-app SDK.
/// Simulator mismatches retain both identities; Sendable across async clients.
public enum SdkDatabaseError: Error, LocalizedError, Sendable {
    case unavailable(String)
    case wrongSimulator(expectedUdid: String, actualUdid: String)
    case badResponse(String)

    public var errorDescription: String? {
        switch self {
        case let .wrongSimulator(expected, actual):
            return SdkEndpointError.wrongSimulatorMessage(expectedUdid: expected, actualUdid: actual)
        case let .unavailable(message):
            return message
        case let .badResponse(message):
            return message
        }
    }
}
