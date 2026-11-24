import Foundation

/// The HID message a head-unit input is sent as, on the CarPlay service (target 1).
public enum CarPlayInputMessage: Equatable, Sendable {
    /// `IndigoHIDMessageForHIDArbitrary` press then release of a HID usage.
    case usage(page: UInt32, usage: UInt32)
    /// One `IOHIDEventCreateScrollEvent` per detent through
    /// `IndigoHIDMessageForScrollEventFromHIDEventRef`, `delta` lines on the vertical axis.
    case scroll(delta: Double)
}

/// CarPlay head-unit inputs besides touch (#19059). SimulatorKit exports no CarPlay knob or
/// button builder, so these are the generic builders that take a target, aimed at the CarPlay
/// service with the standard Consumer-page usages a car knob and its buttons report. No mapping is
/// verified on a simulator yet; the helper reports what it sent, not what CarPlay did.
public enum CarPlayInput: String, CaseIterable, Sendable {
    case back
    case home
    case siri
    case knobSelect = "knob-select"
    case knobUp = "knob-up"
    case knobDown = "knob-down"
    case knobLeft = "knob-left"
    case knobRight = "knob-right"
    case knobClockwise = "knob-cw"
    case knobCounterclockwise = "knob-ccw"

    /// HID Consumer page.
    public static let consumerPage: UInt32 = 0x0C
    /// Detents one `input` call may rotate the knob.
    public static let maxDetents = 50

    public var message: CarPlayInputMessage {
        switch self {
        case .back: .usage(page: Self.consumerPage, usage: 0x224) // AC Back
        case .home: .usage(page: Self.consumerPage, usage: 0x223) // AC Home
        case .siri: .usage(page: Self.consumerPage, usage: 0xCF) // Voice Command
        case .knobSelect: .usage(page: Self.consumerPage, usage: 0x41) // Menu Pick
        case .knobUp: .usage(page: Self.consumerPage, usage: 0x42) // Menu Up
        case .knobDown: .usage(page: Self.consumerPage, usage: 0x43) // Menu Down
        case .knobLeft: .usage(page: Self.consumerPage, usage: 0x44) // Menu Left
        case .knobRight: .usage(page: Self.consumerPage, usage: 0x45) // Menu Right
        // Clockwise moves focus forward, as scrolling down a list does.
        case .knobClockwise: .scroll(delta: -1)
        case .knobCounterclockwise: .scroll(delta: 1)
        }
    }

    /// The StarkConfig hardware the car must declare for this input; Siri has no StarkConfig key.
    public var hardware: StarkHardware? {
        switch self {
        case .back: .backButton
        case .home: .homeButton
        case .siri: nil
        case .knobSelect, .knobClockwise, .knobCounterclockwise: .wheel
        case .knobUp, .knobDown, .knobLeft, .knobRight: .wheelBump
        }
    }
}

/// JSON contract of `input`: what was sent, and the screen and target it went to. `usagePage` and
/// `usage` are present for a usage message, `scrollDelta` for a rotation.
public struct CarPlayInputSent: Codable, Equatable, Sendable {
    public let input: String
    public let count: Int
    public let screenID: UInt32
    public let screenType: UInt64
    public let target: UInt32
    public let usagePage: UInt32?
    public let usage: UInt32?
    public let scrollDelta: Double?
}

public struct CarPlayInputResult: Codable, Equatable, Sendable {
    public let sent: CarPlayInputSent
}

public struct CarPlayInputController {
    /// Time between press and release, as for a tap.
    public static let holdMilliseconds = CarPlayTapController.holdMilliseconds
    /// Time between two knob detents.
    public static let detentMilliseconds = 50
    private let screens: any SimulatorScreenBackend
    private let hid: any CarPlayHIDBackend

    public init(screens: any SimulatorScreenBackend, hid: any CarPlayHIDBackend) {
        self.screens = screens
        self.hid = hid
    }

    /// Refuses, sending nothing, unless the car screen passes the tap checks and the StarkConfig
    /// that powered it declares the input's hardware. `count` is detents for a rotation and must be
    /// 1 for anything else.
    public func send(udid: String, input: CarPlayInput, count: Int = 1) throws -> CarPlayInputResult {
        try Self.requireCount(input, count)
        let car = try PoweredCarScreen.require(screens, udid: udid, action: "CarPlay head-unit inputs")
        if let hardware = input.hardware {
            let config = try screens.readFile(path: StarkConfig.path(dataPath: car.device.dataPath))
            guard StarkConfig.declaredHardware(config).contains(hardware) else {
                throw CarPlayPowerError(
                    .headUnitInputsDisabled,
                    "The CarPlay screen was powered on without \(hardware.rawValue); run carplay-power-helper power-on --head-unit-inputs, then retry."
                )
            }
        }
        // CoreSimulator HID state does not survive a reboot; creating it again is harmless.
        try hid.createCarPlayService()
        switch input.message {
        case let .usage(page, usage):
            try hid.sendUsage(.down, target: car.target, page: page, usage: usage)
            hid.hold(milliseconds: Self.holdMilliseconds)
            try hid.sendUsage(.up, target: car.target, page: page, usage: usage)
        case let .scroll(delta):
            for detent in 0 ..< count {
                if detent > 0 { hid.hold(milliseconds: Self.detentMilliseconds) }
                try hid.sendScroll(target: car.target, delta: delta)
            }
        }
        return CarPlayInputResult(sent: Self.sent(input, count: count, car: car))
    }

    static func requireCount(_ input: CarPlayInput, _ count: Int) throws {
        if case .scroll = input.message {
            guard (1 ... CarPlayInput.maxDetents).contains(count) else {
                throw CarPlayPowerError(
                    .usage,
                    "\(input.rawValue) takes 1 to \(CarPlayInput.maxDetents) detents (got \(count))."
                )
            }
        } else if count != 1 {
            throw CarPlayPowerError(
                .usage,
                "\(input.rawValue) is a single press; only knob-cw and knob-ccw take a count."
            )
        }
    }

    private static func sent(_ input: CarPlayInput, count: Int, car: PoweredCarScreen) -> CarPlayInputSent {
        var page: UInt32?
        var usage: UInt32?
        var delta: Double?
        switch input.message {
        case let .usage(usagePage, usageID):
            page = usagePage
            usage = usageID
        case let .scroll(scrollDelta):
            delta = scrollDelta
        }
        return CarPlayInputSent(
            input: input.rawValue, count: count, screenID: car.screen.id, screenType: car.screen.screenType,
            target: car.target, usagePage: page, usage: usage, scrollDelta: delta
        )
    }
}
