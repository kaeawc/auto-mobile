// swift-tools-version: 6.3
import PackageDescription

// The daemon compiles these same sources with one `swiftc` call (#19118), so SimHidHelper
// imports SimHidCore only when SwiftPM builds it as a separate module.
let package = Package(
    name: "SimHid",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "SimHidCore", targets: ["SimHidCore"]),
        .executable(name: "sim-hid-helper", targets: ["SimHidHelper"]),
    ],
    targets: [
        .target(name: "SimHidCore"),
        .executableTarget(name: "SimHidHelper", dependencies: ["SimHidCore"]),
        .testTarget(name: "SimHidCoreTests", dependencies: ["SimHidCore"]),
    ]
)
