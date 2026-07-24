// swift-tools-version: 6.0
import PackageDescription

// AI-assisted failure recovery (see AutoMobileRecovery.swift / TachikomaPlanRecoveryHandler.swift)
// depends on Tachikoma, which requires Swift tools 6.0 and iOS 17 / macOS 14. The existing runner
// code keeps compiling in the Swift 5 language mode via `.swiftLanguageMode(.v5)` on each target, so
// consuming a Swift 6 package does not force a strict-concurrency migration of this module.
let package = Package(
    name: "XCTestRunner",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
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
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        .testTarget(
            name: "XCTestRunnerTests",
            dependencies: ["XCTestRunner"],
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
