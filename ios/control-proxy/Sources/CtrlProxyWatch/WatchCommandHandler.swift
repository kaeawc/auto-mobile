import AutoMobileSdkWire
import Foundation

@MainActor
protocol WatchSnapshotSource {
    func snapshot() throws -> SdkViewHierarchy
}

@MainActor
protocol WatchGesturePerformer {
    func tap(x: Double, y: Double) throws
    func tap(identifier: String) throws
    func swipe(_ direction: WatchSwipeDirection) throws
    func home() throws
    func rotateCrown(delta: Double, velocity: Double) throws
}

enum WatchSwipeDirection: String, Decodable {
    case up, down, left, right
}

enum WatchCommandError: LocalizedError {
    case unsupported(String)
    case invalidRequest(String)
    case commandFailed(String)
    case appNotForeground

    var errorDescription: String? {
        switch self {
        case let .unsupported(command): return "\(command) is unsupported on watchOS"
        case let .invalidRequest(message), let .commandFailed(message): return message
        case .appNotForeground:
            return "The watch runner app is not in the foreground; open it to observe its hierarchy."
        }
    }

    var code: String {
        switch self {
        case .unsupported: return "unsupported_on_watchos"
        case .invalidRequest: return "invalid_request"
        case .commandFailed: return "command_failed"
        case .appNotForeground: return "app_not_foreground"
        }
    }
}

struct WatchConnectedEvent: Codable {
    let type: String
    let id: Int
    let platform: String
    let supportedCommands: [String]
    let supportedFeatures: [String]

    init(id: Int) {
        type = "connected"
        self.id = id
        platform = "watchos"
        supportedCommands = WatchCommandHandler.supportedCommands
        supportedFeatures = []
    }
}

struct WatchResponse: Codable {
    let type: String
    let requestId: String?
    let success: Bool
    var data: SdkViewHierarchy?
    var error: String?
    var errorCode: String?
}

@MainActor
final class WatchCommandHandler {
    nonisolated static let supportedCommands = ["hierarchy", "tap", "swipe", "home", "crown"]

    private let snapshotSource: any WatchSnapshotSource
    private let gestures: any WatchGesturePerformer

    init(snapshotSource: any WatchSnapshotSource, gestures: any WatchGesturePerformer) {
        self.snapshotSource = snapshotSource
        self.gestures = gestures
    }

    func handle(_ data: Data) -> WatchResponse {
        var requestId: String?
        do {
            let header = try JSONDecoder().decode(Header.self, from: data)
            requestId = header.requestId
            guard Self.supportedCommands.contains(header.type) else {
                throw WatchCommandError.unsupported(header.type)
            }
            switch header.type {
            case "hierarchy":
                return try WatchResponse(
                    type: "hierarchy_update", requestId: requestId, success: true, data: snapshotSource.snapshot()
                )
            case "tap":
                let tap = try JSONDecoder().decode(Tap.self, from: data)
                if let identifier = tap.identifier, !identifier.isEmpty {
                    try gestures.tap(identifier: identifier)
                } else if let x = tap.x, let y = tap.y, x.isFinite, y.isFinite {
                    try gestures.tap(x: x, y: y)
                } else {
                    throw WatchCommandError.invalidRequest("tap requires an identifier or finite x and y coordinates")
                }
            case "swipe":
                let swipe = try JSONDecoder().decode(Swipe.self, from: data)
                try gestures.swipe(swipe.direction)
            case "home":
                try gestures.home()
            case "crown":
                let crown = try JSONDecoder().decode(Crown.self, from: data)
                guard let delta = crown.delta, delta.isFinite else {
                    throw WatchCommandError.invalidRequest("crown requires a finite delta")
                }
                let velocity = crown.velocity ?? 1.0
                guard velocity.isFinite, velocity > 0 else {
                    throw WatchCommandError.invalidRequest("crown requires a finite velocity greater than zero")
                }
                try gestures.rotateCrown(delta: delta, velocity: velocity)
            default:
                throw WatchCommandError.unsupported(header.type)
            }
            return WatchResponse(type: "\(header.type)_result", requestId: requestId, success: true)
        } catch {
            return WatchResponse(
                type: "error", requestId: requestId, success: false,
                error: error.localizedDescription,
                errorCode: (error as? WatchCommandError)?.code
                    ?? (error is DecodingError ? "invalid_request" : "command_failed")
            )
        }
    }

    private struct Header: Decodable {
        let type: String
        let requestId: String?
    }

    private struct Tap: Decodable {
        let identifier: String?
        let x: Double?
        let y: Double?
    }

    private struct Swipe: Decodable {
        let direction: WatchSwipeDirection
    }

    private struct Crown: Decodable {
        let delta: Double?
        let velocity: Double?
    }
}
