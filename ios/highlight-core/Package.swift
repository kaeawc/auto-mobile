// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "AutoMobileHighlightCore",
    platforms: [.iOS(.v17), .macOS(.v15)],
    products: [.library(name: "AutoMobileHighlightCore", targets: ["AutoMobileHighlightCore"])],
    // Swift 6 language mode: complete strict-concurrency checking, warning-free (#5839).
    targets: [
        .target(name: "AutoMobileHighlightCore", swiftSettings: [.swiftLanguageMode(.v6)]),
        .testTarget(
            name: "AutoMobileHighlightCoreTests",
            dependencies: ["AutoMobileHighlightCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
