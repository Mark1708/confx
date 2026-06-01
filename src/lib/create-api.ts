import { ConfluenceApi, extractBaseUrl, type FetchOptions } from "@/lib/confluence-api";
import { JiraApi } from "@/lib/jira-api";
import { DEFAULT_SETTINGS, loadSettings } from "@/lib/settings";
import type { AppSettings } from "@/types";

async function loadApiSettings(): Promise<AppSettings> {
  try {
    return await loadSettings();
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function toFetchOptions(settings: AppSettings): FetchOptions {
  return {
    timeout: settings.requestTimeout,
    maxRetries: settings.maxRetries,
    maxConcurrency: settings.maxConcurrency,
  };
}

export async function createConfluenceApi(host: string): Promise<ConfluenceApi> {
  const settings = await loadApiSettings();
  const baseUrl = extractBaseUrl(settings.confluenceBaseUrl || host);
  return new ConfluenceApi(baseUrl, toFetchOptions(settings));
}

export async function createJiraApi(baseUrl: string): Promise<JiraApi> {
  const settings = await loadApiSettings();
  return new JiraApi(baseUrl, toFetchOptions(settings));
}
