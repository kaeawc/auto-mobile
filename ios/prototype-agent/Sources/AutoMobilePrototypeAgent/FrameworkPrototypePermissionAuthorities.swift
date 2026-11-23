#if canImport(UIKit)
    import AVFoundation
    import Contacts
    import EventKit
    import Photos

    /// Framework operations are lazy so the module can gate them on the host's usage descriptions.
    @MainActor
    struct FrameworkPrototypePermissionAuthority: PrototypePermissionAuthority {
        private let read: () -> PrototypePermissionState
        private let prompt: @MainActor () async throws -> Void
        private let release: () -> Void

        init(
            read: @escaping () -> PrototypePermissionState,
            prompt: @escaping @MainActor () async throws -> Void,
            stop: @escaping () -> Void = {}
        ) {
            self.read = read
            self.prompt = prompt
            release = stop
        }

        static func hostAuthorities() -> [String: any PrototypePermissionAuthority] {
            let location = CLLocationManagerPrototypeLocationSource()
            return [
                "camera": capture(.video),
                "microphone": capture(.audio),
                "photos": photos(.readWrite),
                "photosAdd": photos(.addOnly),
                "contacts": Self(read: { contactsStatus().state }, prompt: {
                    _ = try await CNContactStore().requestAccess(for: .contacts)
                }),
                "calendar": Self(read: { calendarStatus().state }, prompt: {
                    _ = try await EKEventStore().requestFullAccessToEvents()
                }),
                "location": Self(
                    read: { location.permissionAuthorization.state },
                    prompt: { await location.requestAuthorization() },
                    stop: { location.stop() }
                ),
            ]
        }

        func status() async -> PrototypePermissionState { read() }

        func request() async -> PrototypePermissionOutcome {
            guard !Task.isCancelled else { return .cancelled }
            let current = read()
            guard current == .notDetermined else { return .status(current) }
            do {
                try await prompt()
                guard !Task.isCancelled else { return .cancelled }
                return .status(read())
            } catch {
                guard !Task.isCancelled else { return .cancelled }
                let updated = read()
                return updated == .notDetermined ? .platformError : .status(updated)
            }
        }

        func stop() { release() }

        private static func capture(_ type: AVMediaType) -> Self {
            Self(read: { captureStatus(type).state }, prompt: {
                _ = await AVCaptureDevice.requestAccess(for: type)
            })
        }

        private static func captureStatus(_ type: AVMediaType) -> PrototypeCaptureAuthorization {
            switch AVCaptureDevice.authorizationStatus(for: type) {
            case .notDetermined: .notDetermined
            case .restricted: .restricted
            case .denied: .denied
            case .authorized: .authorized
            @unknown default: .unknown
            }
        }

        private static func photos(_ access: PHAccessLevel) -> Self {
            Self(read: { photoStatus(access).state }, prompt: {
                _ = await PHPhotoLibrary.requestAuthorization(for: access)
            })
        }

        private static func photoStatus(_ access: PHAccessLevel) -> PrototypePhotoAuthorization {
            switch PHPhotoLibrary.authorizationStatus(for: access) {
            case .notDetermined: .notDetermined
            case .restricted: .restricted
            case .denied: .denied
            case .authorized: .authorized
            case .limited: .limited
            @unknown default: .unknown
            }
        }

        private static func contactsStatus() -> PrototypeContactsAuthorization {
            let status = CNContactStore.authorizationStatus(for: .contacts)
            if #available(iOS 18.0, *), status == .limited { return .limited }
            switch status {
            case .notDetermined: return .notDetermined
            case .restricted: return .restricted
            case .denied: return .denied
            case .authorized: return .authorized
            default: return .unknown
            }
        }

        private static func calendarStatus() -> PrototypeCalendarAuthorization {
            switch EKEventStore.authorizationStatus(for: .event) {
            case .notDetermined: .notDetermined
            case .restricted: .restricted
            case .denied: .denied
            case .fullAccess: .fullAccess
            case .writeOnly: .writeOnly
            @unknown default: .unknown
            }
        }
    }
#endif
