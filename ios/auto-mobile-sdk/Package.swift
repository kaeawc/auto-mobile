// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "AutoMobileSDK",
    platforms: [
        .iOS(.v17),
        .macOS(.v15),
    ],
    products: [
        .library(
            name: "AutoMobileSDK",
            targets: ["AutoMobileSDK"]
        ),
    ],
    dependencies: [
        .package(path: "../highlight-core"),
        .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.4.3"),
    ],
    // Keep Swift 5 language mode until the strict-concurrency pass (#5839) finishes and v6 is enabled.
    targets: [
        .target(
            name: "AutoMobileSDK",
            dependencies: [.product(name: "AutoMobileHighlightCore", package: "highlight-core")],
            path: "Sources/AutoMobileSDK",
            resources: [.process("PrivacyInfo.xcprivacy")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "AutoMobileSDKTests",
            dependencies: ["AutoMobileSDK"],
            path: "Tests/AutoMobileSDKTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
