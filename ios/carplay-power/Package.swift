// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "CarPlayPower",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "CarPlayPowerCore", targets: ["CarPlayPowerCore"]),
        .executable(name: "carplay-power-helper", targets: ["CarPlayPowerHelper"]),
    ],
    targets: [
        .target(name: "CarPlayPowerCore"),
        .executableTarget(name: "CarPlayPowerHelper", dependencies: ["CarPlayPowerCore"]),
        .testTarget(name: "CarPlayPowerCoreTests", dependencies: ["CarPlayPowerCore"]),
    ]
)
