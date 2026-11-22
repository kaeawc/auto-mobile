enum PrototypeCaptureAuthorization: Sendable {
    case notDetermined, restricted, denied, authorized, unknown

    var state: PrototypePermissionState {
        switch self {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .granted
        case .unknown: .unavailable
        }
    }
}

enum PrototypePhotoAuthorization: Sendable {
    case notDetermined, restricted, denied, authorized, limited, unknown

    var state: PrototypePermissionState {
        switch self {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .granted
        case .limited: .limited
        case .unknown: .unavailable
        }
    }
}

enum PrototypeContactsAuthorization: Sendable {
    case notDetermined, restricted, denied, authorized, limited, unknown

    var state: PrototypePermissionState {
        switch self {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .authorized: .granted
        case .limited: .limited
        case .unknown: .unavailable
        }
    }
}

enum PrototypeCalendarAuthorization: Sendable {
    case notDetermined, restricted, denied, fullAccess, writeOnly, unknown

    var state: PrototypePermissionState {
        switch self {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .fullAccess: .granted
        case .writeOnly: .limited
        case .unknown: .unavailable
        }
    }
}

enum PrototypeWhenInUseAuthorization: Sendable {
    case notDetermined, restricted, denied, whenInUse, always, unknown

    var state: PrototypePermissionState {
        switch self {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .whenInUse, .always: .granted
        case .unknown: .unavailable
        }
    }
}
