import Foundation

public struct AXBridgeError: Error, Codable, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public static let accessibilityNotTrusted = AXBridgeError(
        code: "accessibility_not_trusted",
        message: "AXBridge needs Accessibility trust. Enable this process in System Settings "
            + "(Privacy & Security > Accessibility), then retry."
    )

    public static func preflight(isTrusted: Bool) -> AXBridgeError? {
        isTrusted ? nil : accessibilityNotTrusted
    }

    /// AX status values are plain integers here so the core never imports ApplicationServices.
    public static func axFailure(status: Int32, operation: String) -> AXBridgeError? {
        guard status != 0 else { return nil }
        let codes: [Int32: String] = [
            -25200: "ax_failure",
            -25201: "ax_illegal_argument",
            -25202: "ax_invalid_ui_element",
            -25203: "ax_invalid_ui_element_observer",
            -25204: "ax_cannot_complete",
            -25205: "ax_attribute_unsupported",
            -25206: "ax_action_unsupported",
            -25207: "ax_notification_unsupported",
            -25208: "ax_not_implemented",
            -25209: "ax_notification_already_registered",
            -25210: "ax_notification_not_registered",
            -25211: "ax_api_disabled",
            -25212: "ax_no_value",
            -25213: "ax_parameterized_attribute_unsupported",
            -25214: "ax_not_enough_precision",
        ]
        return AXBridgeError(
            code: codes[status] ?? "ax_error_\(status)",
            message: "\(operation) failed with AXError \(status)."
        )
    }
}
