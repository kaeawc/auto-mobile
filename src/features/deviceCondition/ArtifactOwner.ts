/**
 * Shared by a device's fixtures (#16275): which fixture still needs each file a fixture planted.
 * `rootState` and `integrityState` plant the same su and Superuser stubs, so neither may delete
 * one while the other still depends on it. The last holder to release a planted file removes it.
 */
export class ArtifactOwner {
  private readonly holders = new Map<string, Set<object>>();
  private readonly planted = new Set<string>();

  /** Record that `token` needs `path` present, whoever put it there. */
  hold(token: object, path: string): void {
    const holders = this.holders.get(path) ?? new Set<object>();
    holders.add(token);
    this.holders.set(path, holders);
  }

  /** Record that `token` planted `path`, so a fixture, not the image, owns its removal. */
  plant(token: object, path: string): void {
    this.hold(token, path);
    this.planted.add(path);
  }

  heldByOther(token: object, path: string): boolean {
    return [...(this.holders.get(path) ?? [])].some((holder) => holder !== token);
  }

  /**
   * A fixture-planted file another fixture still needs: not `token`'s to report or remove. An
   * image-shipped file is never one, even while another fixture depends on it.
   */
  plantedForOther(token: object, path: string): boolean {
    return this.planted.has(path) && this.heldByOther(token, path);
  }

  /** Whether `token` releasing `path` leaves a fixture-planted file nobody needs, to delete. */
  removableBy(token: object, path: string): boolean {
    return this.planted.has(path) && !this.heldByOther(token, path);
  }

  /** Drop `token`'s need for `path`; the file stays fixture-owned while another holder needs it. */
  release(token: object, path: string): void {
    const holders = this.holders.get(path);
    holders?.delete(token);
    if (!holders || holders.size === 0) {
      this.holders.delete(path);
      this.planted.delete(path);
    }
  }
}

export const artifactOwnersByDevice = new Map<string, ArtifactOwner>();

export function resolveArtifactOwner(
  deviceId: string,
  owners: Map<string, ArtifactOwner> = artifactOwnersByDevice,
): ArtifactOwner {
  let owner = owners.get(deviceId);
  if (!owner) {
    owner = new ArtifactOwner();
    owners.set(deviceId, owner);
  }
  return owner;
}
