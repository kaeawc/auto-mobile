// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "AutoMobileHighlightCore",
    platforms: [.iOS(.v17), .macOS(.v15)],
    products: [.library(name: "AutoMobileHighlightCore", targets: ["AutoMobileHighlightCore"])],
    // Keep Swift 5 language mode until the strict-concurrency pass (#5839) finishes and v6 is enabled.
    targets: [
        .target(name: "AutoMobileHighlightCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(
            name: "AutoMobileHighlightCoreTests",
            dependencies: ["AutoMobileHighlightCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
