import { archivePathKey, assertArchivePath } from "./paths";

interface PathRecord {
  archivePath: string;
  kind: "file" | "directory";
  protected?: boolean;
  ownershipKey?: string;
}

interface RegistryState {
  deduplicate: boolean;
  paths: Map<string, PathRecord>;
  canonicalPaths: Map<string, string>;
}

export interface AssetReservation {
  archivePath: string;
  isNew: boolean;
}

export interface PageAssetRegistry {
  reserve(
    hash: string,
    normalizedExtension: string,
    proposedArchivePath: string,
    ownershipKey?: string,
  ): AssetReservation;
  commit(): void;
  discard(): void;
}

const PAGE_FILES = ["index.md", "editable.md", "comments.json", "history.json"];
const PAGE_DIRECTORIES = [
  "images",
  "tables",
  "attachments",
  "attachments/comments",
  "attachments/linked/plantuml",
];

/** Job-wide metadata only. A page publishes reservations only after all its entries are written. */
export class AssetRegistry {
  private readonly state: RegistryState;

  constructor(deduplicate: boolean) {
    this.state = { deduplicate, paths: new Map(), canonicalPaths: new Map() };
  }

  protectPage(folder: string): void {
    const normalizedFolder = folder.normalize("NFC");
    if (normalizedFolder) assertArchivePath(normalizedFolder);
    this.protectDirectory(normalizedFolder);
    for (const directory of PAGE_DIRECTORIES) {
      this.protectDirectory(joinPath(normalizedFolder, directory));
    }
    for (const name of PAGE_FILES) {
      const archivePath = joinPath(normalizedFolder, name);
      const key = archivePathKey(archivePath);
      const existing = this.state.paths.get(key);
      if (existing && (existing.kind !== "file" || !existing.protected)) {
        throw new Error(`Page path conflicts with an asset: ${archivePath}`);
      }
      this.state.paths.set(key, { archivePath, kind: "file", protected: true });
    }
  }

  beginPage(folder: string): PageAssetRegistry {
    this.protectPage(folder);
    return new PageAssets(this.state);
  }

  private protectDirectory(path: string): void {
    if (!path) return;
    let parent = "";
    for (const segment of path.split("/")) {
      const proposed = joinPath(parent, segment);
      const key = archivePathKey(proposed);
      const existing = this.state.paths.get(key);
      if (existing?.kind === "file")
        throw new Error(`Page directory conflicts with a file: ${proposed}`);
      if (existing) {
        parent = existing.archivePath;
      } else {
        this.state.paths.set(key, { archivePath: proposed, kind: "directory", protected: true });
        parent = proposed;
      }
    }
  }
}

class PageAssets implements PageAssetRegistry {
  // These overlays contain only this attempt's additions; committed maps are never copied.
  private readonly paths = new Map<string, PathRecord>();
  private readonly canonicalPaths = new Map<string, string>();
  private closed = false;

  constructor(private readonly state: RegistryState) {}

  reserve(
    hash: string,
    normalizedExtension: string,
    proposedArchivePath: string,
    ownershipKey?: string,
  ): AssetReservation {
    this.assertOpen();
    const proposed = proposedArchivePath.normalize("NFC");
    assertArchivePath(proposed);
    const extension = normalizedExtension.replace(/^\.+/, "").toLowerCase();
    const contentKey = JSON.stringify([ownershipKey ?? null, hash.toLowerCase(), extension]);
    if (this.state.deduplicate) {
      const existing =
        this.canonicalPaths.get(contentKey) ?? this.state.canonicalPaths.get(contentKey);
      if (existing !== undefined) return { archivePath: existing, isNew: false };
    }

    const segments = proposed.split("/");
    let parent = "";
    for (const segment of segments.slice(0, -1)) {
      const archivePath = this.availablePath(parent, segment, hash, "directory", ownershipKey);
      const key = archivePathKey(archivePath);
      if (!this.lookup(key)) this.paths.set(key, { archivePath, kind: "directory", ownershipKey });
      parent = archivePath;
    }
    const archivePath = this.availablePath(parent, segments.at(-1)!, hash, "file", ownershipKey);
    this.paths.set(archivePathKey(archivePath), { archivePath, kind: "file", ownershipKey });
    if (this.state.deduplicate) this.canonicalPaths.set(contentKey, archivePath);
    return { archivePath, isNew: true };
  }

  commit(): void {
    this.assertOpen();
    // Validate the complete overlay first, so an overlapping transaction cannot partially commit.
    for (const [key, record] of this.paths) {
      const existing = this.state.paths.get(key);
      if (
        existing &&
        (record.kind !== "directory" ||
          existing.kind !== "directory" ||
          existing.archivePath !== record.archivePath ||
          (!existing.protected && existing.ownershipKey !== record.ownershipKey))
      ) {
        throw new Error(`Asset path committed by another page: ${record.archivePath}`);
      }
    }
    for (const [key, record] of this.paths) {
      if (!this.state.paths.has(key)) this.state.paths.set(key, record);
    }
    for (const [key, path] of this.canonicalPaths) {
      if (!this.state.canonicalPaths.has(key)) this.state.canonicalPaths.set(key, path);
    }
    this.close();
  }

  discard(): void {
    this.close();
  }

  private availablePath(
    parent: string,
    name: string,
    hash: string,
    kind: PathRecord["kind"],
    ownershipKey?: string,
  ): string {
    const proposed = joinPath(parent, name);
    const existing = this.lookup(archivePathKey(proposed));
    if (!existing) return proposed;
    if (
      kind === "directory" &&
      existing.kind === "directory" &&
      (existing.protected || existing.ownershipKey === ownershipKey)
    )
      return existing.archivePath;

    const dot = kind === "file" ? name.lastIndexOf(".") : -1;
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    const fullHash = hash.toLowerCase();
    let numericSuffix = 2;
    let hashLength = Math.min(8, fullHash.length);
    while (true) {
      const suffix =
        this.state.deduplicate && hashLength > 0
          ? `${fullHash.slice(0, hashLength)}${hashLength > fullHash.length ? `-${numericSuffix++}` : ""}`
          : String(numericSuffix++);
      const candidate = joinPath(parent, `${stem}-${suffix}${extension}`);
      const collision = this.lookup(archivePathKey(candidate));
      if (!collision) return candidate;
      if (
        kind === "directory" &&
        collision.kind === "directory" &&
        (collision.protected || collision.ownershipKey === ownershipKey)
      )
        return collision.archivePath;
      if (this.state.deduplicate && hashLength <= fullHash.length) {
        hashLength =
          hashLength < fullHash.length
            ? Math.min(hashLength + 4, fullHash.length)
            : fullHash.length + 1;
      }
    }
  }

  private lookup(key: string): PathRecord | undefined {
    return this.paths.get(key) ?? this.state.paths.get(key);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Asset page transaction is closed");
  }

  private close(): void {
    this.closed = true;
    this.paths.clear();
    this.canonicalPaths.clear();
  }
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}
