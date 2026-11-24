/// NSEvent types `IndigoHIDMessageForMouseNSEvent` accepts for the touch digitizer.
public enum SimHidTouchPhase: UInt, Sendable, Equatable {
    case down = 1
    case up = 2
    case dragged = 6
}

/// One HID message, or a pause between messages.
public enum SimHidStep: Sendable, Equatable {
    /// Points are normalized to 0–1; `second` is the second finger of a two-finger gesture.
    case touch(SimHidPoint, second: SimHidPoint?, phase: SimHidTouchPhase)
    case button(source: UInt32, down: Bool)
    case key(usage: UInt32, down: Bool)
    case wait(ms: Double)
}

public enum SimHidPlanner {
    /// SimulatorKit coalesces (returns no message for) a drag sent less than ~16 ms after the last one.
    public static let moveIntervalMs = 17.0

    public static let buttonSources: [SimHidButton: UInt32] = [
        .home: 0x0,
        .lock: 0x1,
        .side: 0xBB8,
        .siri: 0x400002,
    ]

    /// Every step for a command. Validation happens here, so a bad command sends nothing.
    public static func steps(for command: SimHidCommand) throws -> [SimHidStep] {
        switch command {
        case .ping:
            return []
        case let .tap(point, holdMs, screen):
            let normalized = normalize(point, screen)
            return [.touch(normalized, second: nil, phase: .down)] + pause(holdMs)
                + [.touch(normalized, second: nil, phase: .up)]
        case let .swipe(from, to, durationMs, screen):
            return drag(durationMs: durationMs) { fraction in
                (normalize(interpolate(from, to, fraction), screen), nil)
            }
        case let .pinch(center, startRadius, endRadius, durationMs, screen):
            return drag(durationMs: durationMs) { fraction in
                let radius = startRadius + (endRadius - startRadius) * fraction
                return (
                    normalize(SimHidPoint(x: center.x - radius, y: center.y), screen),
                    normalize(SimHidPoint(x: center.x + radius, y: center.y), screen)
                )
            }
        case let .key(name, modifiers):
            return try keyChord(name, modifiers)
        case let .type(text):
            return try typing(text)
        case let .button(button, holdMs):
            let source = buttonSources[button] ?? 0
            return [.button(source: source, down: true)] + pause(holdMs) + [.button(source: source, down: false)]
        }
    }

    public static func normalize(_ point: SimHidPoint, _ screen: SimHidScreen) -> SimHidPoint {
        SimHidPoint(x: clamp(point.x / screen.width), y: clamp(point.y / screen.height))
    }

    private static func clamp(_ value: Double) -> Double {
        min(1, max(0, value))
    }

    private static func interpolate(_ from: SimHidPoint, _ to: SimHidPoint, _ fraction: Double) -> SimHidPoint {
        SimHidPoint(x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction)
    }

    private static func pause(_ ms: Double) -> [SimHidStep] {
        ms > 0 ? [.wait(ms: ms)] : []
    }

    /// Finger(s) down, one drag every `moveIntervalMs` across the duration, then up at the end point.
    private static func drag(
        durationMs: Double,
        at position: (Double) -> (SimHidPoint, SimHidPoint?)
    )
        -> [SimHidStep]
    {
        let moves = max(2, Int(durationMs / moveIntervalMs))
        let start = position(0)
        var steps: [SimHidStep] = [.touch(start.0, second: start.1, phase: .down)]
        for index in 1 ... moves {
            let point = position(Double(index) / Double(moves))
            steps.append(.wait(ms: moveIntervalMs))
            steps.append(.touch(point.0, second: point.1, phase: .dragged))
        }
        let end = position(1)
        steps.append(.touch(end.0, second: end.1, phase: .up))
        return steps
    }

    private static func keyChord(_ name: String, _ modifiers: [String]) throws -> [SimHidStep] {
        guard let usage = SimHidKeyboard.usage(forKey: name) else {
            throw SimHidError("unsupported-key", "Key \(name) has no HID keyboard usage")
        }
        var held: [UInt32] = []
        for modifier in modifiers {
            guard let modifierUsage = SimHidKeyboard.modifierUsages[modifier] else {
                throw SimHidError("unsupported-key", "Modifier \(modifier) has no HID keyboard usage")
            }
            if !held.contains(modifierUsage) { held.append(modifierUsage) }
        }
        return held.map { .key(usage: $0, down: true) }
            + [.key(usage: usage, down: true), .key(usage: usage, down: false)]
            + held.reversed().map { .key(usage: $0, down: false) }
    }

    private static func typing(_ text: String) throws -> [SimHidStep] {
        try text.flatMap { character -> [SimHidStep] in
            guard let (usage, shift) = SimHidKeyboard.usage(for: character) else {
                throw SimHidError("unsupported-character", "Character \(character) has no US HID keyboard usage")
            }
            let press: [SimHidStep] = [.key(usage: usage, down: true), .key(usage: usage, down: false)]
            guard shift else { return press }
            return [.key(usage: SimHidKeyboard.leftShift, down: true)] + press
                + [.key(usage: SimHidKeyboard.leftShift, down: false)]
        }
    }
}
