// swift-tools-version: 6.3
import PackageDescription

// ScreenCaptureHelper is a Swift-6 strict-concurrency package: language mode v6 by
// default under swift-tools-version 6.3, matching the ios/XCTestRunner and root
// manifests' Swift 6.3 / macOS 15 toolchain floor (PR #6014). macOS-only — it links
// ScreenCaptureKit, AVFoundation, and VideoToolbox. Do NOT add .swiftLanguageMode
// or warnings-as-errors here; warnings-as-errors is applied repo-wide by
// scripts/ios/swift-build.sh and swift-test.sh (`-Xswiftc -warnings-as-errors`).
let package = Package(
    name: "ScreenCaptureHelper",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(
            name: "screen-capture-helper",
            targets: ["ScreenCaptureHelper"]
        ),
        .library(
            name: "ScreenCaptureCore",
            targets: ["ScreenCaptureCore"]
        ),
    ],
    targets: [
        .target(
            name: "ScreenCaptureCore",
            path: "Sources/ScreenCaptureCore"
        ),
        .executableTarget(
            name: "ScreenCaptureHelper",
            dependencies: ["ScreenCaptureCore"],
            path: "Sources/ScreenCaptureHelper"
        ),
        .testTarget(
            name: "ScreenCaptureCoreTests",
            dependencies: ["ScreenCaptureCore"],
            path: "Tests/ScreenCaptureCoreTests"
        ),
        .testTarget(
            name: "ScreenCaptureHelperTests",
            dependencies: ["ScreenCaptureHelper"],
            path: "Tests/ScreenCaptureHelperTests"
        ),
    ]
)
