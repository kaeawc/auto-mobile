// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "auto-mobile",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "AutoMobileSDK",
            targets: ["AutoMobileSDK"]
        ),
        .library(
            name: "XCTestRunner",
            targets: ["XCTestRunner"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.4.3"),
    ],
    targets: [
        .target(
            name: "AutoMobileSDK",
            path: "ios/auto-mobile-sdk/Sources/AutoMobileSDK",
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        .target(
            name: "XCTestRunner",
            path: "ios/XCTestRunner/Sources/XCTestRunner"
        ),
    ]
)
