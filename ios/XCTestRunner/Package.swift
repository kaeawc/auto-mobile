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
        .library(
            name: "XCTestRunnerRewrite",
            targets: ["XCTestRunnerRewrite"]
        ),
    ],
    dependencies: [
        // Pinned to an exact released tag for hermetic, reproducible CI builds.
        .package(url: "https://github.com/steipete/Tachikoma.git", exact: "1.0.0"),
    ],
    targets: [
        // MARK: Reference implementation (behavioral oracle)

        // The shipped implementation. Pinned to Swift 5 language mode so it keeps building as the
        // parity oracle while `XCTestRunnerRewrite` is brought up under strict concurrency — a
        // per-target mode avoids forcing the reference (with its semaphore-ordered clients,
        // unsynchronized statics, and thread-local session) to migrate in lockstep. Retired once the
        // rewrite reaches parity, at which point `XCTestRunnerRewrite` is renamed back to `XCTestRunner`.
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

        // MARK: Swift-6 concurrency-clean rewrite (in progress)

        .target(
            name: "XCTestRunnerRewrite",
            dependencies: [
                .product(name: "Tachikoma", package: "Tachikoma"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        // Differential parity + rewrite unit tests. Links BOTH the reference and the rewrite so it can
        // diff old vs new behavior against shared wire/plan fixtures.
        .testTarget(
            name: "XCTestRunnerRewriteTests",
            dependencies: ["XCTestRunner", "XCTestRunnerRewrite"],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
