// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "XcodeCompanion",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(
            name: "AutoMobileCompanion",
            targets: ["AutoMobileCompanion"]
        ),
    ],
    dependencies: [
        // SwiftUI and Combine are built-in
    ],
    targets: [
        .target(
            name: "AutoMobileCompanionCore",
            dependencies: [],
            path: "Sources/AutoMobileCompanion",
            exclude: ["AutoMobileCompanionApp.swift"],
            resources: [
                .process("Resources"),
            ]
        ),
        .executableTarget(
            name: "AutoMobileCompanion",
            dependencies: ["AutoMobileCompanionCore"],
            path: "Sources/AutoMobileCompanion",
            sources: ["AutoMobileCompanionApp.swift"]
        ),
        .testTarget(
            name: "AutoMobileCompanionTests",
            dependencies: ["AutoMobileCompanionCore"]
        ),
    ]
)
