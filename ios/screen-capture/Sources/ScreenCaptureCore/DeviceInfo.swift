import Foundation

/// Serializable description of a discovered capture device. Emitted to stdout
/// in JSON form when `screen-capture-helper --list-devices` is invoked.
public struct DeviceInfo: Codable, Equatable {
    public let uniqueID: String
    public let localizedName: String
    public let modelID: String
    public let manufacturer: String

    public init(uniqueID: String, localizedName: String, modelID: String, manufacturer: String) {
        self.uniqueID = uniqueID
        self.localizedName = localizedName
        self.modelID = modelID
        self.manufacturer = manufacturer
    }
}

public struct DeviceListResponse: Codable, Equatable {
    public let devices: [DeviceInfo]

    public init(devices: [DeviceInfo]) {
        self.devices = devices
    }
}
