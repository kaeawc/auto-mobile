import Foundation

/// Errors surfaced when relaying database inspection to the in-app SDK. Ported
/// verbatim from the reference `SdkDatabaseClient.swift`; `Sendable` because it is
/// thrown across the async client boundary.
public enum SdkDatabaseError: Error, LocalizedError, Sendable {
    case unavailable(String)
    case badResponse(String)

    public var errorDescription: String? {
        switch self {
        case let .unavailable(message):
            return message
        case let .badResponse(message):
            return message
        }
    }
}
