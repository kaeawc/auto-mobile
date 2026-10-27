import Foundation

// Haptic and sound feedback calls (#14329). The modules map a validated call onto a player; the
// session keeps the verifiable log. Players are protocols so the mapping and the ring bound are
// testable without UIKit; the agent target supplies the UIKit and AudioToolbox players.

/// The `haptics.perform` effect vocabulary, in the contract's order.
public enum PrototypeHapticEffect: String, CaseIterable, Sendable {
    case click, tick, heavyClick, doubleClick, selection, success, warning, error
    case impactLight, impactMedium, impactHeavy, longPress
}

/// The closed `sound.play` list; audio asset ids wait for the audio asset type (#14254).
public enum PrototypeSoundCue: String, CaseIterable, Sendable {
    case click, send, receive, shutter
}

public enum PrototypeFeedbackOutcome: Equatable, Sendable {
    case played
    /// A system setting stopped it; logged as `suppressed`.
    case suppressed
    /// The hardware or service is absent.
    case unavailable
}

@MainActor
public protocol PrototypeHapticsPlayer {
    func perform(_ effect: PrototypeHapticEffect) -> PrototypeFeedbackOutcome
}

@MainActor
public protocol PrototypeSoundPlayer {
    /// `volume` is 0-100 or nil; a player that cannot honour it ignores it.
    func play(_ cue: PrototypeSoundCue, volume: Int?) -> PrototypeFeedbackOutcome
}

/// `haptics.perform`: no events, no state, no permission.
@MainActor
public final class PrototypeHapticsModule: PrototypePlatformModule {
    public let name = "haptics"
    public let capability = "prototype_platform_haptics_v1"
    public let events = AsyncStream<PlatformEvent> { $0.finish() }
    public let state: [String: JSONValue] = [:]
    private let player: any PrototypeHapticsPlayer

    public init(player: any PrototypeHapticsPlayer) {
        self.player = player
    }

    public func availability() -> PlatformAvailability { .ready }

    public func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "haptics.perform" else { return .failure(.unsupported, "Unknown call \(call.call)") }
        guard let effect = call.args["effect"]?.stringValue.flatMap(PrototypeHapticEffect.init(rawValue:)) else {
            return .failure(.invalidArgs, "effect must be one of the haptics.perform effects")
        }
        return PrototypeFeedbackResult.result(player.perform(effect), unavailable: "haptics unavailable on this device")
    }
}

/// `sound.play`.
@MainActor
public final class PrototypeSoundModule: PrototypePlatformModule {
    public let name = "sound"
    public let capability = "prototype_platform_sound_v1"
    public let events = AsyncStream<PlatformEvent> { $0.finish() }
    public let state: [String: JSONValue] = [:]
    private let player: any PrototypeSoundPlayer

    public init(player: any PrototypeSoundPlayer) {
        self.player = player
    }

    public func availability() -> PlatformAvailability { .ready }

    public func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "sound.play" else { return .failure(.unsupported, "Unknown call \(call.call)") }
        guard let cue = call.args["sound"]?.stringValue.flatMap(PrototypeSoundCue.init(rawValue:)) else {
            return .failure(.invalidArgs, "sound must be click, send, receive or shutter")
        }
        var volume: Int?
        if let raw = call.args["volume"] {
            guard case let .number(number) = raw, number == number.rounded(), (0 ... 100).contains(number) else {
                return .failure(.invalidArgs, "volume must be 0 to 100")
            }
            volume = Int(number)
        }
        return PrototypeFeedbackResult.result(
            player.play(cue, volume: volume), unavailable: "sound unavailable on this device"
        )
    }
}

enum PrototypeFeedbackResult {
    static func result(_ outcome: PrototypeFeedbackOutcome, unavailable: String) -> PlatformCallResult {
        outcome == .unavailable
            ? .failure(.unavailable, unavailable)
            : .success(.object(["suppressed": .bool(outcome == .suppressed)]))
    }
}

/// One finished feedback call, reported by `inspect` as `feedbackLog`.
struct PrototypeFeedbackEntry: Equatable, Sendable {
    let timeMs: Int
    let effect: String?
    let sound: String?
    let nodeId: String?
    let suppressed: Bool

    var wireObject: JSONValue {
        var fields: [String: JSONValue] = ["timeMs": .number(Double(timeMs))]
        if let effect { fields["effect"] = .string(effect) }
        if let sound { fields["sound"] = .string(sound) }
        if let nodeId { fields["nodeId"] = .string(nodeId) }
        if suppressed { fields["suppressed"] = .bool(true) }
        return .object(fields)
    }

    /// The entry a successful finished call adds, or nil for any other call or result.
    static func entry(
        call: String, args: [String: JSONValue], result: PlatformCallResult, nodeId: String?, timeMs: Int
    )
        -> PrototypeFeedbackEntry?
    {
        guard case let .success(value) = result else { return nil }
        let suppressed = value.objectFields?["suppressed"] == .bool(true)
        switch call {
        case "haptics.perform":
            return args["effect"]?.stringValue.map {
                PrototypeFeedbackEntry(timeMs: timeMs, effect: $0, sound: nil, nodeId: nodeId, suppressed: suppressed)
            }
        case "sound.play":
            return args["sound"]?.stringValue.map {
                PrototypeFeedbackEntry(timeMs: timeMs, effect: nil, sound: $0, nodeId: nodeId, suppressed: suppressed)
            }
        default:
            return nil
        }
    }
}

/// The last `capacity` entries, oldest first.
struct PrototypeFeedbackLog: Equatable, Sendable {
    static let capacity = 64
    private(set) var entries: [PrototypeFeedbackEntry] = []

    mutating func record(_ entry: PrototypeFeedbackEntry) {
        entries.append(entry)
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    }

    var wireArray: JSONValue? {
        entries.isEmpty ? nil : .array(entries.map(\.wireObject))
    }
}

extension PrototypeNode {
    /// The id of the one node under `root` whose tap, long-press or double-tap list holds a call
    /// equal to `action`; nil when none or several do (a platform handler, an unnamed node, or the
    /// same call authored twice).
    static func owningNodeId(of action: PrototypeAction, in root: PrototypeNode) -> String? {
        var owners = Set<String>()
        func holds(_ list: [PrototypeAction]?) -> Bool {
            list?.contains { $0.type == action.type && $0.call == action.call && $0.args == action.args } == true
        }
        func visit(_ node: PrototypeNode) {
            if let id = node.id, holds(node.onTap) || holds(node.onLongPress) || holds(node.onDoubleTap) {
                owners.insert(id)
            }
            node.children?.forEach(visit)
            if let child = node.child { visit(child) }
            node.screens?.values.forEach(visit)
        }
        visit(root)
        return owners.count == 1 ? owners.first : nil
    }
}

/// How one effect is produced with UIKit's feedback generators.
public enum PrototypeHapticPlan: Equatable, Sendable {
    public enum Impact: Equatable, Sendable { case light, medium, heavy, rigid, soft }
    public enum Notification: Equatable, Sendable { case success, warning, error }

    case impact(Impact)
    case selection
    case notification(Notification)
    /// Two impacts `gapMs` apart.
    case double(Impact, gapMs: Int)

    public static func plan(for effect: PrototypeHapticEffect) -> PrototypeHapticPlan {
        switch effect {
        case .click, .impactMedium: .impact(.medium)
        case .tick, .impactLight: .impact(.light)
        case .heavyClick, .impactHeavy: .impact(.heavy)
        case .longPress: .impact(.rigid)
        case .doubleClick: .double(.medium, gapMs: 80)
        case .selection: .selection
        case .success: .notification(.success)
        case .warning: .notification(.warning)
        case .error: .notification(.error)
        }
    }
}

/// The `AudioServices` system sound that stands in for each cue, so the agent bundles no audio and
/// leaves the host's `AVAudioSession` alone. `AudioServicesPlaySystemSound` has no volume.
public enum PrototypeSystemSound {
    public static func id(for cue: PrototypeSoundCue) -> UInt32 {
        switch cue {
        case .click: 1104
        case .send: 1001
        case .receive: 1007
        case .shutter: 1108
        }
    }
}
