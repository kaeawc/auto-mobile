// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ScreenCaptureHelper",
    platforms: [
        .macOS(.v14),
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
