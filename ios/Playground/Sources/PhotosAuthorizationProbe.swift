import Foundation
import Photos

protocol PhotosAuthorizationStatusProviding {
    func rawStatus(readWrite: Bool) -> Int
}

struct LivePhotosAuthorizationStatusProvider: PhotosAuthorizationStatusProviding {
    func rawStatus(readWrite: Bool) -> Int {
        PHPhotoLibrary.authorizationStatus(for: readWrite ? .readWrite : .addOnly).rawValue
    }
}

struct PhotosAuthorizationSnapshot: Codable, Equatable {
    struct Status: Codable, Equatable {
        let rawValue: Int
        let name: String

        init(rawValue: Int) {
            self.rawValue = rawValue
            switch rawValue {
            case 0: name = "notDetermined"
            case 1: name = "restricted"
            case 2: name = "denied"
            case 3: name = "authorized"
            case 4: name = "limited"
            default: name = "unknown"
            }
        }
    }

    let readWrite: Status
    let addOnly: Status
    let observedAt: String

    init(readWrite: Int, addOnly: Int, observedAt: Date) {
        self.readWrite = Status(rawValue: readWrite)
        self.addOnly = Status(rawValue: addOnly)
        self.observedAt = ISO8601DateFormatter().string(from: observedAt)
    }
}

protocol PhotosAuthorizationFileWriting {
    func write(_ data: Data, to url: URL, options: Data.WritingOptions) throws
}

struct DefaultPhotosAuthorizationFileWriter: PhotosAuthorizationFileWriting {
    func write(_ data: Data, to url: URL, options: Data.WritingOptions) throws {
        try data.write(to: url, options: options)
    }
}

struct PhotosAuthorizationProbe {
    private let provider: any PhotosAuthorizationStatusProviding
    private let dateProvider: () -> Date
    private let directoryURL: URL
    private let fileWriter: any PhotosAuthorizationFileWriting

    init(
        provider: any PhotosAuthorizationStatusProviding,
        dateProvider: @escaping () -> Date,
        directoryURL: URL,
        fileWriter: any PhotosAuthorizationFileWriting = DefaultPhotosAuthorizationFileWriter()
    ) {
        self.provider = provider
        self.dateProvider = dateProvider
        self.directoryURL = directoryURL
        self.fileWriter = fileWriter
    }

    static func writeLiveSnapshotToDocuments() throws {
        let directoryURL = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        try PhotosAuthorizationProbe(
            provider: LivePhotosAuthorizationStatusProvider(),
            dateProvider: Date.init,
            directoryURL: directoryURL
        ).write()
    }

    func write() throws {
        let snapshot = PhotosAuthorizationSnapshot(
            readWrite: provider.rawStatus(readWrite: true),
            addOnly: provider.rawStatus(readWrite: false),
            observedAt: dateProvider()
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try fileWriter.write(
            encoder.encode(snapshot),
            to: directoryURL.appendingPathComponent("photos-authorization.json", isDirectory: false),
            options: .atomic
        )
    }
}
