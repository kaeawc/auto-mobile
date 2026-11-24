import Foundation

/// A point in screen points, or normalized to 0–1 once planned.
public struct SimHidPoint: Sendable, Equatable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// The screen size, in points, that touch coordinates are relative to.
public struct SimHidScreen: Sendable, Equatable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public enum SimHidButton: String, Sendable, Equatable, CaseIterable {
    case home
    case lock
    case side
    case siri
}

public enum SimHidCommand: Sendable, Equatable {
    case ping
    case tap(point: SimHidPoint, holdMs: Double, screen: SimHidScreen)
    case swipe(from: SimHidPoint, to: SimHidPoint, durationMs: Double, screen: SimHidScreen)
    case pinch(center: SimHidPoint, startRadius: Double, endRadius: Double, durationMs: Double, screen: SimHidScreen)
    case key(name: String, modifiers: [String])
    case type(text: String)
    case button(SimHidButton, holdMs: Double)
}

public struct SimHidRequest: Sendable, Equatable {
    public let id: String
    public let command: SimHidCommand

    public init(id: String, command: SimHidCommand) {
        self.id = id
        self.command = command
    }
}

public struct SimHidError: Error, Sendable, Equatable, Codable {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// One JSON object per stdin line: `{"id":"1","cmd":"tap","x":10,"y":20,"width":402,"height":874}`.
private struct RawRequest: Decodable {
    let id: String?
    let cmd: String?
    let x: Double?
    let y: Double?
    let toX: Double?
    let toY: Double?
    let holdMs: Double?
    let durationMs: Double?
    let width: Double?
    let height: Double?
    let startRadius: Double?
    let endRadius: Double?
    let key: String?
    let modifiers: [String]?
    let text: String?
    let button: String?
}

public enum SimHidRequestParser {
    /// Longest accepted hold or gesture; a longer value is a caller bug, not a real gesture.
    public static let maxDurationMs = 10000.0

    public static func requestID(_ line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let raw = try? JSONDecoder().decode(RawRequest.self, from: data)
        else { return nil }
        return raw.id
    }

    public static func parse(_ line: String) throws -> SimHidRequest {
        let raw: RawRequest
        do {
            raw = try JSONDecoder().decode(RawRequest.self, from: Data(line.utf8))
        } catch {
            throw SimHidError("invalid-command", "Command is not a JSON object: \(error.localizedDescription)")
        }
        guard let id = raw.id, !id.isEmpty else { throw SimHidError("invalid-command", "Command has no id") }
        guard let cmd = raw.cmd else { throw SimHidError("invalid-command", "Command \(id) has no cmd") }
        return try SimHidRequest(id: id, command: command(cmd, raw))
    }

    private static func command(_ cmd: String, _ raw: RawRequest) throws -> SimHidCommand {
        switch cmd {
        case "ping":
            return .ping
        case "tap":
            return try .tap(point: point(raw.x, raw.y, "x/y"), holdMs: duration(raw.holdMs ?? 0), screen: screen(raw))
        case "swipe":
            return try .swipe(
                from: point(raw.x, raw.y, "x/y"), to: point(raw.toX, raw.toY, "toX/toY"),
                durationMs: duration(raw.durationMs ?? 300), screen: screen(raw)
            )
        case "pinch":
            guard let start = raw.startRadius, let end = raw.endRadius, start >= 0, end >= 0 else {
                throw SimHidError("invalid-command", "pinch needs non-negative startRadius and endRadius")
            }
            return try .pinch(
                center: point(raw.x, raw.y, "x/y"), startRadius: start, endRadius: end,
                durationMs: duration(raw.durationMs ?? 300), screen: screen(raw)
            )
        case "key":
            guard let key = raw.key, !key.isEmpty else { throw SimHidError("invalid-command", "key needs a key name") }
            return .key(name: key, modifiers: raw.modifiers ?? [])
        case "type":
            guard let text = raw.text, !text.isEmpty else { throw SimHidError("invalid-command", "type needs text") }
            return .type(text: text)
        case "button":
            guard let name = raw.button, let button = SimHidButton(rawValue: name) else {
                let names = SimHidButton.allCases.map(\.rawValue).joined(separator: ", ")
                throw SimHidError("invalid-command", "button must be one of \(names)")
            }
            return try .button(button, holdMs: duration(raw.holdMs ?? 0))
        default:
            throw SimHidError("invalid-command", "Unknown cmd \(cmd)")
        }
    }

    private static func point(_ x: Double?, _ y: Double?, _ label: String) throws -> SimHidPoint {
        guard let x, let y, x.isFinite, y.isFinite else {
            throw SimHidError("invalid-command", "Command needs finite \(label)")
        }
        return SimHidPoint(x: x, y: y)
    }

    private static func screen(_ raw: RawRequest) throws -> SimHidScreen {
        guard let width = raw.width, let height = raw.height, width > 0, height > 0, width.isFinite,
              height.isFinite
        else { throw SimHidError("invalid-command", "Touch commands need a positive width and height in points") }
        return SimHidScreen(width: width, height: height)
    }

    private static func duration(_ value: Double) throws -> Double {
        guard value.isFinite, value >= 0, value <= maxDurationMs else {
            throw SimHidError("invalid-command", "Durations must be 0–\(Int(maxDurationMs)) ms")
        }
        return value
    }
}
