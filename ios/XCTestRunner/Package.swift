// swift-tools-version: 6.3
import PackageDescription

// XCTestRunner is a Swift-6 strict-concurrency package (language mode v6 by default under
// swift-tools-version 6.3). It depends on Tachikoma for AI-assisted failure recovery
// (see AutoMobileRecovery.swift / TachikomaPlanRecoveryHandler.swift), which requires iOS 17 / macOS 15.
let package = Package(
    name: "XCTestRunner",
    platforms: [
        .iOS(.v17),
        .macOS(.v15),
    ],
    products: [
        .library(
            name: "XCTestRunner",
            targets: ["XCTestRunner"]
        ),
    ],
    dependencies: [
        // Pinned to an exact released tag for hermetic, reproducible CI builds.
        .package(url: "https://github.com/steipete/Tachikoma.git", exact: "1.0.0"),
    ],
    targets: [
        .target(
            name: "XCTestRunner",
            dependencies: [
                .product(name: "Tachikoma", package: "Tachikoma"),
            ]
        ),
        // Shared test doubles. NOT a dependency of the `.library` product, so the shipped module stays
        // fake-free and Sendable-clean.
        .target(
            name: "XCTestRunnerTestSupport",
            dependencies: ["XCTestRunner"]
        ),
        .testTarget(
            name: "XCTestRunnerTests",
            dependencies: ["XCTestRunner", "XCTestRunnerTestSupport"],
            resources: [
                .process("Resources"),
            ]
        ),
    ]
)
