// swift-tools-version: 6.3
import PackageDescription

// This root manifest is the published SPM entry point (consumers add the repo URL and pick the
// `XCTestRunner` / `AutoMobileSDK` products). The `XCTestRunner` target compiles the same sources as
// ios/XCTestRunner, which now depend on Tachikoma for AI-assisted recovery — so the dependency,
// Swift 6.0 tools, and the iOS 17 / macOS 14 floor are declared here too. Existing sources keep
// compiling in the Swift 5 language mode via `.swiftLanguageMode(.v5)`.
let package = Package(
    name: "auto-mobile",
    platforms: [
        .iOS(.v17),
        .macOS(.v15),
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
        .library(
            name: "XCTestRunnerRewrite",
            targets: ["XCTestRunnerRewrite"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.4.3"),
        // Powers AI-assisted recovery in XCTestRunner. Pinned to an exact tag for reproducible builds.
        .package(url: "https://github.com/steipete/Tachikoma.git", exact: "1.0.0"),
    ],
    targets: [
        .target(
            name: "AutoMobileSDK",
            path: "ios/auto-mobile-sdk/Sources/AutoMobileSDK",
            resources: [.process("PrivacyInfo.xcprivacy")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "XCTestRunner",
            dependencies: [.product(name: "Tachikoma", package: "Tachikoma")],
            path: "ios/XCTestRunner/Sources/XCTestRunner",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // Swift-6 concurrency-clean rewrite (in progress). Compiled by `ios-spm-root-package-build`
        // so the strict-concurrency target is release-built alongside the reference oracle until the
        // cutover renames it back to `XCTestRunner`.
        .target(
            name: "XCTestRunnerRewrite",
            dependencies: [.product(name: "Tachikoma", package: "Tachikoma")],
            path: "ios/XCTestRunner/Sources/XCTestRunnerRewrite",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
