export function safeZipSegment(value: string): string {
  const sanitized = Array.from(value.normalize("NFC"))
    .map((char) => (isUnsafeZipChar(char) ? "-" : char))
    .join("")
    .replace(/^\.+$/, "")
    .trim();
  return sanitized;
}

export function isUnsafeZipChar(char: string): boolean {
  return char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char);
}

export function assertArchivePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || safeZipSegment(part) !== part)
  ) {
    throw new RangeError("Unsafe archive path");
  }
}

/** Conservative caseless identity for directory volumes; spelling stays explicit. */
export function archivePathKey(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** The same final-path guard is used before any output backend touches an entry. */
export class ArchivePathGuard {
  private readonly files = new Set<string>();
  private readonly directories = new Map<string, string>();

  claim(path: string): void {
    assertArchivePath(path);
    const key = archivePathKey(path);
    if (this.files.has(key) || this.directories.has(key)) {
      throw new RangeError("Duplicate or conflicting archive path");
    }
    const parts = path.split("/");
    const unclaimedParents: Array<[string, string]> = [];
    let parent = "";
    for (let index = 0; index < parts.length - 1; index++) {
      parent = parent ? `${parent}/${parts[index]}` : parts[index];
      const parentKey = archivePathKey(parent);
      const spelling = this.directories.get(parentKey);
      if (this.files.has(parentKey) || (spelling !== undefined && spelling !== parent)) {
        throw new RangeError("Conflicting archive directory");
      }
      if (spelling === undefined) unclaimedParents.push([parentKey, parent]);
    }
    // Parents become visible only after the whole path validated; a failed claim leaves no ghosts.
    for (const [parentKey, value] of unclaimedParents) this.directories.set(parentKey, value);
    this.files.add(key);
  }
}
