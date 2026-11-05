// Independent of XCTest so the window-app boundary is testable on macOS.
enum VisionCommandPolicy {
    static let supportedCommands = [
        "request_hierarchy", "request_tap_element", "request_append_text",
    ]

    static func supports(_ command: String) -> Bool {
        supportedCommands.contains(command)
    }
}
