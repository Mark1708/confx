export type TabAccessState =
  | "available"
  | "unsupported-url"
  | "host-access-missing"
  | "injection-failed";

export type SupportedTabAccessState = Exclude<TabAccessState, "unsupported-url">;

export interface SupportedTabAccessInfo {
  state: SupportedTabAccessState;
  origin: string;
  originPattern: string;
}

export type TabAccessInfo = { state: "unsupported-url" } | SupportedTabAccessInfo;

export function classifyTabAccess(url: string): TabAccessInfo {
  const originPattern = currentOriginPattern(url);
  if (!originPattern) return { state: "unsupported-url" };

  return {
    state: "available",
    origin: originPattern.slice(0, -2),
    originPattern,
  };
}

export function currentOriginPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

export function isCurrentOriginPattern(pattern: string): boolean {
  if (!pattern.endsWith("/*")) return false;
  const origin = pattern.slice(0, -2);
  if (origin.includes("*")) return false;

  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.origin === origin &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}
