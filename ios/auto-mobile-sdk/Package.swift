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
    // Swift 6 language mode: complete strict-concurrency checking, warning-free (#5839).
    targets: [
        .target(
            name: "AutoMobileSDK",
            dependencies: [.product(name: "AutoMobileHighlightCore", package: "highlight-core")],
            path: "Sources/AutoMobileSDK",
            resources: [.process("PrivacyInfo.xcprivacy")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "AutoMobileSDKTests",
            dependencies: ["AutoMobileSDK"],
            path: "Tests/AutoMobileSDKTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
