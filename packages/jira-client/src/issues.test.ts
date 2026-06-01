import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJiraClient } from './client.js';
import { fetchIssueChangelog, streamJqlIssues } from './issues.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchIssueChangelog', () => {
  it('paginates the changelog subresource when it is available', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `cl-${index + 1}`,
      created: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      items: [{ field: 'status', from: '1', to: '2' }],
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 101,
          values: firstPage,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          startAt: 100,
          maxResults: 100,
          total: 101,
          values: [
            {
              id: 'cl-101',
              created: '2026-02-01T00:00:00.000Z',
              items: [{ field: 'status', from: '2', to: '3' }],
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createJiraClient('https://jira.example.internal', 'pat-123', {
      changelogFetchStrategy: 'subresource',
    });
    const histories = await fetchIssueChangelog(client, 'PROJ-1');

    expect(histories).toHaveLength(101);
    expect(histories[0]?.id).toBe('cl-1');
    expect(histories[100]?.id).toBe('cl-101');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://jira.example.internal/rest/api/2/issue/PROJ-1/changelog?startAt=0&maxResults=100',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://jira.example.internal/rest/api/2/issue/PROJ-1/changelog?startAt=100&maxResults=100',
      expect.any(Object),
    );
  });

  it('falls back to issue expansion when the changelog subresource probe returns 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          changelog: {
            startAt: 0,
            maxResults: 2,
            total: 2,
            histories: [
              {
                id: 'cl-1',
                created: '2026-01-02T00:00:00.000Z',
                items: [{ field: 'status', from: '1', to: '2' }],
              },
              {
                id: 'cl-2',
                created: '2026-01-03T00:00:00.000Z',
                items: [{ field: 'status', from: '2', to: '3' }],
              },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createJiraClient('https://jira.example.internal', 'pat-123');
    const histories = await fetchIssueChangelog(client, 'PROJ-1');

    expect(histories.map((history) => history.id)).toEqual(['cl-1', 'cl-2']);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://jira.example.internal/rest/api/2/issue/PROJ-1/changelog?startAt=0&maxResults=1',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://jira.example.internal/rest/api/2/issue/PROJ-1?expand=changelog&fields=summary',
      expect.any(Object),
    );
  });

  it('reuses issue expansion after detecting the changelog subresource is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          changelog: {
            startAt: 0,
            maxResults: 1,
            total: 1,
            histories: [
              {
                id: 'cl-1',
                created: '2026-01-02T00:00:00.000Z',
                items: [{ field: 'status', from: '1', to: '2' }],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          changelog: {
            startAt: 0,
            maxResults: 1,
            total: 1,
            histories: [
              {
                id: 'cl-2',
                created: '2026-01-03T00:00:00.000Z',
                items: [{ field: 'status', from: '2', to: '3' }],
              },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createJiraClient('https://jira.example.internal', 'pat-123');

    await expect(fetchIssueChangelog(client, 'PROJ-1')).resolves.toHaveLength(1);
    await expect(fetchIssueChangelog(client, 'PROJ-2')).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://jira.example.internal/rest/api/2/issue/PROJ-2?expand=changelog&fields=summary',
      expect.any(Object),
    );
  });

  it('uses a single changelog availability probe for concurrent fallback calls', async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes('/changelog')) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      return Promise.resolve(
        jsonResponse({
          changelog: {
            startAt: 0,
            maxResults: 0,
            total: 0,
            histories: [],
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createJiraClient('https://jira.example.internal', 'pat-123');

    await Promise.all([
      fetchIssueChangelog(client, 'PROJ-1'),
      fetchIssueChangelog(client, 'PROJ-2'),
      fetchIssueChangelog(client, 'PROJ-3'),
    ]);

    const changelogCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/changelog'),
    );
    const issueDetailCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('expand=changelog'),
    );
    expect(changelogCalls).toHaveLength(1);
    expect(issueDetailCalls).toHaveLength(3);
  });
});

describe('streamJqlIssues', () => {
  function makeIssue(id: string) {
    return {
      id,
      key: `PROJ-${id}`,
      fields: {
        summary: `Issue ${id}`,
        status: { id: '10001', name: 'Closed' },
        issuetype: { id: '1', name: 'Story' },
        project: { id: 'p1', key: 'PROJ' },
        created: '2025-01-01T00:00:00.000Z',
      },
    };
  }

  it('paginates through all pages and yields every issue', async () => {
    const page1Issues = [makeIssue('1'), makeIssue('2')];
    const page2Issues = [makeIssue('3')];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ startAt: 0, maxResults: 2, total: 3, issues: page1Issues }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ startAt: 2, maxResults: 2, total: 3, issues: page2Issues }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createJiraClient('https://jira.example.internal', 'pat-123');
    const results: string[] = [];
    for await (const issue of streamJqlIssues(client, 'filter = 1001 AND status = "10001"', { maxResults: 2 })) {
      results.push(issue.id);
    }

    expect(results).toEqual(['1', '2', '3']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCallUrl = String(fetchMock.mock.calls[0]![0]);
    expect(firstCallUrl).toContain('/rest/api/2/search');
    expect(firstCallUrl).toContain('filter+%3D+1001');
  });

  it('de-duplicates issues that appear on multiple pages', async () => {
    const issue1 = makeIssue('1');
    const issue2 = makeIssue('2');
    const issue3 = makeIssue('3');

    // issue2 appears on both pages (live reordering edge case)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ startAt: 0, maxResults: 2, total: 3, issues: [issue1, issue2] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ startAt: 2, maxResults: 2, total: 3, issues: [issue2, issue3] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createJiraClient('https://jira.example.internal', 'pat-123');
    const results: string[] = [];
    for await (const issue of streamJqlIssues(client, 'project = PROJ', { maxResults: 2 })) {
      results.push(issue.id);
    }

    expect(results).toEqual(['1', '2', '3']);
  });

  it('forwards the fields parameter when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ startAt: 0, maxResults: 50, total: 0, issues: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createJiraClient('https://jira.example.internal', 'pat-123');
    const results: string[] = [];
    for await (const issue of streamJqlIssues(client, 'project = PROJ', { fields: 'summary,status' })) {
      results.push(issue.id);
    }

    expect(results).toEqual([]);
    const calledUrl = String(fetchMock.mock.calls[0]![0]);
    expect(calledUrl).toContain('fields=summary%2Cstatus');
  });
});
