// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SimulatorNetworkFilter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "network-filter-controller", targets: ["NetworkFilterController"]),
        .executable(name: "network-filter-provider", targets: ["NetworkFilterProvider"]),
    ],
    targets: [
        .target(name: "NetworkFilterCore"),
        .executableTarget(name: "NetworkFilterController", dependencies: ["NetworkFilterCore"]),
        .executableTarget(name: "NetworkFilterProvider", dependencies: ["NetworkFilterCore"]),
        .testTarget(name: "NetworkFilterCoreTests", dependencies: ["NetworkFilterCore"]),
    ]
)
