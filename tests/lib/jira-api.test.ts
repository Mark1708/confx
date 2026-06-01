import { beforeEach, describe, expect, it, vi } from "vitest";

import { JiraApi, toIssueMeta } from "@/lib/jira-api";
import { AuthError, type JiraAttachment, type JiraComment, type JiraIssueMeta, NetworkError } from "@/types";

const fetchMock = vi.fn<typeof fetch>();

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

const makeIssue = (key: string, summary = `Summary ${key}`): Record<string, unknown> => ({
  key,
  fields: {
    project: { key: key.split("-")[0] },
    summary,
    issuetype: { name: "Task" },
    status: { name: "In Progress" },
    priority: { name: "High" },
    resolution: null,
    assignee: { key: "assignee-1" },
    reporter: { key: "reporter-1" },
    labels: ["docs", "export"],
    components: [{ name: "Frontend" }],
    versions: [{ name: "1.0" }],
    fixVersions: [{ name: "1.1" }],
    customfield_10100: "EPIC-1",
    created: "2026-05-01T10:00:00.000Z",
    updated: "2026-05-02T10:00:00.000Z",
    duedate: "2026-06-01",
  },
});

const expectedMeta = (key: string, summary = `Summary ${key}`): JiraIssueMeta => ({
  key,
  project: key.split("-")[0],
  type: "Task",
  status: "In Progress",
  priority: "High",
  resolution: null,
  summary,
  assignee: "assignee-1",
  reporter: "reporter-1",
  labels: ["docs", "export"],
  components: ["Frontend"],
  versions: ["1.0"],
  fixVersions: ["1.1"],
  epicLink: "EPIC-1",
  created: "2026-05-01T10:00:00.000Z",
  updated: "2026-05-02T10:00:00.000Z",
  dueDate: "2026-06-01",
  baseUrl: "https://jira.example.com",
  url: `https://jira.example.com/browse/${key}`,
});

describe("toIssueMeta", () => {
  it("maps raw Jira issue fields to metadata", () => {
    expect(toIssueMeta(makeIssue("DOC-123"), "https://jira.example.com")).toEqual(
      expectedMeta("DOC-123"),
    );
  });

  it("uses safe defaults for missing optional fields", () => {
    expect(toIssueMeta({ key: "OPS-7", fields: { summary: "Only summary" } }, "https://jira.example.com")).toEqual({
      key: "OPS-7",
      project: "OPS",
      type: "",
      status: "",
      priority: "",
      resolution: null,
      summary: "Only summary",
      assignee: null,
      reporter: null,
      labels: [],
      components: [],
      versions: [],
      fixVersions: [],
      epicLink: null,
      created: "",
      updated: "",
      dueDate: null,
      baseUrl: "https://jira.example.com",
      url: "https://jira.example.com/browse/OPS-7",
    });
  });
});

describe("JiraApi", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("stores the normalized host passed to the constructor", () => {
    const api = new JiraApi("https://jira.example.com/");

    expect(api.host).toBe("https://jira.example.com");
  });

  it("getIssue fetches a Jira issue by key and maps metadata", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeIssue("DOC-123")));
    const api = new JiraApi("https://jira.example.com/");

    await expect(api.getIssue("DOC-123")).resolves.toEqual(expectedMeta("DOC-123"));

    expect(fetchMock).toHaveBeenCalledWith("https://jira.example.com/rest/api/2/issue/DOC-123", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("getIssue preserves Jira base paths when building REST URLs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeIssue("KAFKA-15501")));
    const api = new JiraApi("https://issues.apache.org/jira");

    await expect(api.getIssue("KAFKA-15501")).resolves.toMatchObject({
      key: "KAFKA-15501",
      baseUrl: "https://issues.apache.org/jira",
      url: "https://issues.apache.org/jira/browse/KAFKA-15501",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://issues.apache.org/jira/rest/api/2/issue/KAFKA-15501",
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("searchIssues encodes JQL and maxResults and maps each issue", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ issues: [makeIssue("DOC-1", "First"), makeIssue("DOC-2", "Second")], total: 2 }),
    );
    const api = new JiraApi("https://jira.example.com");

    await expect(api.searchIssues("project = DOC ORDER BY updated DESC", 25)).resolves.toEqual([
      expectedMeta("DOC-1", "First"),
      expectedMeta("DOC-2", "Second"),
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira.example.com/rest/api/2/search?jql=project+%3D+DOC+ORDER+BY+updated+DESC&maxResults=25",
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("searchIssues uses 50 as the default maxResults", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [], total: 0 }));
    const api = new JiraApi("https://jira.example.com");

    await expect(api.searchIssues("project = DOC")).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira.example.com/rest/api/2/search?jql=project+%3D+DOC&maxResults=50",
      {
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("getComments fetches and maps issue comments", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        comments: [
          {
            id: "10001",
            author: { key: "commenter-1" },
            created: "2026-05-03T10:00:00.000Z",
            body: "Looks good",
          },
        ],
      }),
    );
    const api = new JiraApi("https://jira.example.com");
    const expected: JiraComment[] = [
      {
        id: "10001",
        author: "commenter-1",
        createdAt: "2026-05-03T10:00:00.000Z",
        body: "Looks good",
        markdown: "Looks good",
      },
    ];

    await expect(api.getComments("DOC-123")).resolves.toEqual(expected);

    expect(fetchMock).toHaveBeenCalledWith("https://jira.example.com/rest/api/2/issue/DOC-123/comment", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("getAttachments extracts attachments from an issue response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        key: "DOC-123",
        fields: {
          attachment: [
            {
              id: "att-1",
              filename: "diagram.png",
              mimeType: "image/png",
              size: 2048,
              content: "https://jira.example.com/secure/attachment/att-1/diagram.png",
            },
          ],
        },
      }),
    );
    const api = new JiraApi("https://jira.example.com");
    const expected: JiraAttachment[] = [
      {
        id: "att-1",
        fileName: "diagram.png",
        mediaType: "image/png",
        fileSize: 2048,
        contentUrl: "https://jira.example.com/secure/attachment/att-1/diagram.png",
      },
    ];

    await expect(api.getAttachments("DOC-123")).resolves.toEqual(expected);

    expect(fetchMock).toHaveBeenCalledWith("https://jira.example.com/rest/api/2/issue/DOC-123", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("fetchBlob downloads relative attachment paths with credentials", async () => {
    fetchMock.mockResolvedValueOnce(new Response("file content", { headers: { "Content-Type": "text/plain" } }));
    const api = new JiraApi("https://jira.example.com");

    const blob = await api.fetchBlob("secure/attachment/att-1/readme.txt");

    expect(await blob.text()).toBe("file content");
    expect(blob.type).toBe("text/plain");
    expect(fetchMock).toHaveBeenCalledWith("https://jira.example.com/secure/attachment/att-1/readme.txt", {
      credentials: "include",
    });
  });

  it("fetchBlob preserves absolute attachment URLs", async () => {
    fetchMock.mockResolvedValueOnce(new Response("binary"));
    const api = new JiraApi("https://jira.example.com");

    await api.fetchBlob("https://cdn.example.com/attachment.bin");

    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example.com/attachment.bin", {
      credentials: "include",
    });
  });

  it("throws AuthError for 401 Jira API responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "login" }, { status: 401, statusText: "Unauthorized" }));
    const api = new JiraApi("https://jira.example.com");
    const request = api.getIssue("DOC-123");

    await expect(request).rejects.toBeInstanceOf(AuthError);
  });

  it("throws NetworkError after retrying network failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("failed"));
    const api = new JiraApi("https://jira.example.com", { maxRetries: 0 });

    await expect(api.getIssue("DOC-123")).rejects.toBeInstanceOf(NetworkError);
  });
});
