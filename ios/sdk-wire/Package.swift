// swift-tools-version: 6.3
import PackageDescription

// The wire models the in-app AutoMobile SDK and the CtrlProxy XCUITest runner exchange over the
// SDK's loopback HTTP server, declared once. Foundation only: no UIKit, so both packages (which ship
// on different cadences) and the macOS `swift test` destination can use it.
let package = Package(
    name: "AutoMobileSdkWire",
    platforms: [.iOS(.v17), .macOS(.v15)],
    products: [.library(name: "AutoMobileSdkWire", targets: ["AutoMobileSdkWire"])],
    // Swift 6 language mode: complete strict-concurrency checking, warning-free (#5839).
    targets: [
        .target(name: "AutoMobileSdkWire", swiftSettings: [.swiftLanguageMode(.v6)]),
        .testTarget(
            name: "AutoMobileSdkWireTests",
            dependencies: ["AutoMobileSdkWire"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
