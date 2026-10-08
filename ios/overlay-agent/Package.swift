// swift-tools-version: 6.3
import PackageDescription

/// Host-testable slice of the overlay agent. The agent itself is a UIKit simulator dylib built by
/// scripts/ios/overlay-agent-build.sh; this package compiles only its pure connection protocol
/// (launch configuration, framing and the hello/auth gate) so `swift test` covers it on macOS.
let package = Package(
    name: "AutoMobileOverlayAgent",
    platforms: [.iOS(.v17), .macOS(.v15)],
    targets: [
        .target(
            name: "AutoMobileOverlayAgent",
            path: "Sources/AutoMobileOverlayAgent",
            sources: ["OverlayAgentProtocol.swift"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "AutoMobileOverlayAgentTests",
            dependencies: ["AutoMobileOverlayAgent"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
