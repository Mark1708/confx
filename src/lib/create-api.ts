import { ConfluenceApi, type FetchOptions } from "@/lib/confluence-api";
import { JiraApi } from "@/lib/jira-api";
import { canonicalBaseUrl } from "@/lib/source-context";
import type { AppSettings } from "@/types";

export function toFetchOptions(
  settings: Pick<AppSettings, "requestTimeout" | "maxRetries" | "maxConcurrency">,
): FetchOptions {
  return {
    timeout: settings.requestTimeout,
    maxRetries: settings.maxRetries,
    maxConcurrency: settings.maxConcurrency,
  };
}

export function createConfluenceApi(resolvedBaseUrl: string, options: FetchOptions): ConfluenceApi {
  const base = new URL(canonicalBaseUrl(resolvedBaseUrl));
  return new ConfluenceApi({ origin: base.origin, basePath: base.pathname }, options);
}

export function createJiraApi(resolvedBaseUrl: string, options: FetchOptions): JiraApi {
  return new JiraApi(canonicalBaseUrl(resolvedBaseUrl), options);
}
