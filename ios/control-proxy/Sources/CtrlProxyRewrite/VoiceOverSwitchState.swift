import Foundation

enum VoiceOverSwitchState: Equatable {
    case tapNeeded
    case alreadyInState

    static func decision(for value: Any?, enabled: Bool) throws -> Self {
        let isOn: Bool
        if let string = value as? String {
            switch string {
            case "1": isOn = true
            case "0": isOn = false
            default: throw VoiceOverToggleError.switchStateUnreadable
            }
        } else if let number = value as? NSNumber {
            if number == NSNumber(value: 1) {
                isOn = true
            } else if number == NSNumber(value: 0) {
                isOn = false
            } else {
                throw VoiceOverToggleError.switchStateUnreadable
            }
        } else if let boolean = value as? Bool {
            isOn = boolean
        } else {
            throw VoiceOverToggleError.switchStateUnreadable
        }
        return isOn == enabled ? .alreadyInState : .tapNeeded
    }
}
