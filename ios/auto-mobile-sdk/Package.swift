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
    dependencies: [
        .package(path: "../highlight-core"),
        .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.4.3"),
    ],
    targets: [
        .target(
            name: "AutoMobileSDK",
            dependencies: [.product(name: "AutoMobileHighlightCore", package: "highlight-core")],
            path: "Sources/AutoMobileSDK",
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        .testTarget(
            name: "AutoMobileSDKTests",
            dependencies: ["AutoMobileSDK"],
            path: "Tests/AutoMobileSDKTests"
        ),
    ]
)
