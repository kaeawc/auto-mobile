// swift-tools-version: 6.3
import PackageDescription

// Only the UIKit-free core (spec decoding, conditions, the event/state session) is a SwiftPM
// target, so `swift test` runs on a macOS host without a simulator. The injectable dylib — this
// core plus the UIKit/SwiftUI sources in Sources/AutoMobileOverlayAgent and Loader.c — is built
// for the iOS simulator by scripts/ios/overlay-agent-build.sh, which CI runs from swift-build.sh.
let package = Package(
    name: "AutoMobileOverlayAgent",
    platforms: [.iOS(.v17), .macOS(.v15)],
    targets: [
        .target(name: "AutoMobileOverlayAgentCore", swiftSettings: [.swiftLanguageMode(.v6)]),
        .testTarget(
            name: "AutoMobileOverlayAgentCoreTests",
            dependencies: ["AutoMobileOverlayAgentCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
