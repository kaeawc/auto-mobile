import Foundation

enum PrototypeWindowOrientation: String, Decodable { case portrait, landscape, unlocked }
enum PrototypeWindowStatusBar: String, Decodable { case light, dark, auto }

enum PrototypeWindowBrightness: Decodable, Equatable {
    case system
    case percent(Int)

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let keyword = try? value.decode(String.self), keyword == "system" {
            self = .system
        } else {
            let percent = try value.decode(Int.self)
            guard (0 ... 100).contains(percent) else {
                throw DecodingError.dataCorruptedError(
                    in: value,
                    debugDescription: "brightness must be 0-100 or system"
                )
            }
            self = .percent(percent)
        }
    }
}

struct PrototypeWindowControls: Decodable, Equatable {
    let keepScreenOn: Bool?
    let brightness: PrototypeWindowBrightness?
    let orientation: PrototypeWindowOrientation?
    let statusBar: PrototypeWindowStatusBar?
}

@MainActor
protocol PrototypeApplicationIdleTimer: AnyObject {
    var isIdleTimerDisabled: Bool { get set }
}

@MainActor
protocol PrototypeWindowScreen: AnyObject {
    /// UIKit's normalized 0-1 value, read back after every assignment.
    var brightness: Double { get set }
}

@MainActor
protocol PrototypeWindowChrome: AnyObject {
    /// Nil restores the host's original mask. UIKit reports request acceptance separately from errors.
    func requestOrientation(_ orientation: PrototypeWindowOrientation?) -> String
    func setStatusBar(_ style: PrototypeWindowStatusBar?)
    func restore()
}

/// Owns only the controls the spec overrides. Replacements retain the host's original values;
/// removing a field restores that control immediately, and dismissing restores everything.
@MainActor
final class PrototypeWindowControlsRuntime {
    private let idleTimer: any PrototypeApplicationIdleTimer
    private let screen: any PrototypeWindowScreen
    private let chrome: any PrototypeWindowChrome
    private var previousIdleTimer: Bool?
    private var previousBrightness: Double?
    private var applied: PrototypeWindowControls?

    init(
        idleTimer: any PrototypeApplicationIdleTimer,
        screen: any PrototypeWindowScreen,
        chrome: any PrototypeWindowChrome
    ) {
        self.idleTimer = idleTimer
        self.screen = screen
        self.chrome = chrome
    }

    @discardableResult
    func apply(_ controls: PrototypeWindowControls?) -> [String: JSONValue]? {
        guard controls != applied else { return nil }
        let old = applied
        applied = controls
        var result: [String: JSONValue] = [:]
        if let keepScreenOn = controls?.keepScreenOn {
            if previousIdleTimer == nil { previousIdleTimer = idleTimer.isIdleTimerDisabled }
            idleTimer.isIdleTimerDisabled = keepScreenOn
            result["keepScreenOn"] = .bool(idleTimer.isIdleTimerDisabled)
        } else if let previousIdleTimer {
            idleTimer.isIdleTimerDisabled = previousIdleTimer
            self.previousIdleTimer = nil
        }
        if let brightness = applyBrightness(controls?.brightness) { result["brightness"] = brightness }
        if old?.orientation != controls?.orientation {
            result["orientation"] = .string(chrome.requestOrientation(controls?.orientation))
        }
        if old?.statusBar != controls?.statusBar { chrome.setStatusBar(controls?.statusBar) }
        if controls == nil { chrome.restore() }
        return result
    }

    private func applyBrightness(_ brightness: PrototypeWindowBrightness?) -> JSONValue? {
        if case let .percent(percent) = brightness {
            if previousBrightness == nil { previousBrightness = screen.brightness }
            screen.brightness = Double(percent) / 100
            return .object([
                "requested": .number(Double(percent)), "applied": .number(screen.brightness * 100),
            ])
        }
        if let previousBrightness {
            screen.brightness = previousBrightness
            self.previousBrightness = nil
        }
        guard brightness == .system else { return nil }
        return .object([
            "requested": .string("system"), "applied": .number(screen.brightness * 100),
        ])
    }
}
