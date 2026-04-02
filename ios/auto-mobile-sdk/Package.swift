// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AutoMobileSDK",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "AutoMobileSDK",
            targets: ["AutoMobileSDK"]
        ),
    ],
    targets: [
        .target(
            name: "AutoMobileSDK",
            path: "Sources/AutoMobileSDK",
            resources: [.process("PrivacyInfo.xcprivacy")],
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
        .testTarget(
            name: "AutoMobileSDKTests",
            dependencies: ["AutoMobileSDK"],
            path: "Tests/AutoMobileSDKTests",
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
    ]
)
