// swift-tools-version: 6.3
import PackageDescription

/// AudioLoopbackHelper feeds an iOS Simulator's microphone and records its speaker through the host's
/// CoreAudio loopback devices (#13628, #13629). macOS-only: it links AudioToolbox and CoreAudio. Swift 6
/// language mode by default under swift-tools-version 6.3, like ios/screen-capture; warnings-as-errors is
/// applied repo-wide by scripts/ios/swift-build.sh and swift-test.sh.
let package = Package(
    name: "AudioLoopbackHelper",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(
            name: "audio-loopback-helper",
            targets: ["AudioLoopbackHelper"]
        ),
        .library(
            name: "AudioLoopbackCore",
            targets: ["AudioLoopbackCore"]
        ),
    ],
    targets: [
        .target(
            name: "AudioLoopbackCore",
            path: "Sources/AudioLoopbackCore"
        ),
        .executableTarget(
            name: "AudioLoopbackHelper",
            dependencies: ["AudioLoopbackCore"],
            path: "Sources/AudioLoopbackHelper"
        ),
        .testTarget(
            name: "AudioLoopbackCoreTests",
            dependencies: ["AudioLoopbackCore"],
            path: "Tests/AudioLoopbackCoreTests"
        ),
    ]
)
