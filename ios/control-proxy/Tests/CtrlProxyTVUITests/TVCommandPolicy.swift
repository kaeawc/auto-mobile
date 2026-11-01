// Kept independent of XCTest and UIKit so macOS SwiftPM tests cover the capability boundary.
enum TVCommandPolicy {
    static let supportedCommands = ["request_hierarchy", "request_press_button"]

    static func supports(_ command: String) -> Bool {
        supportedCommands.contains(command)
    }
}

enum TVRemoteButton: String, CaseIterable {
    case moveUp = "up"
    case down, left, right, select, menu, home, playPause
}
