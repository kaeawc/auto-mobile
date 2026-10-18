import type {
  PhotosAuthorizationStatus,
  PhotosAuthorizationVerifier,
} from "./IosSimulatorPermissions";

/** Host TCC readback cannot observe the target app's effective PhotoKit status. */
export class UnobservablePhotosAuthorizationVerifier implements PhotosAuthorizationVerifier {
  async verifyReadWrite(_deviceId: string, _appId: string): Promise<PhotosAuthorizationStatus> {
    return "unobservable";
  }
}
