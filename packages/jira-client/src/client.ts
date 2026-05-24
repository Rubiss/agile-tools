import pRetry, { AbortError } from 'p-retry';
import pLimit from 'p-limit';
import { metricsClock, recordJiraRequest } from '@agile-tools/shared';

const CONCURRENCY_LIMIT = 3;
const RETRY_ATTEMPTS = 3;

export class JiraClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'JiraClientError';
  }
}

export interface JiraServerInfo {
  version: string;
  /** 'Server' or 'Cloud' */
  deploymentType: string;
  baseUrl: string;
}

export interface FetchOptions {
  params?: Record<string, string | number | boolean>;
}

function jiraOperation(path: string): string {
  if (path === '/rest/api/2/myself') return 'myself';
  if (path === '/rest/api/2/serverInfo') return 'server_info';
  if (path === '/rest/agile/1.0/board') return 'board_list';
  if (/^\/rest\/agile\/1\.0\/board\/[^/]+\/issue$/.test(path)) return 'board_issues';
  if (/^\/rest\/agile\/1\.0\/board\/[^/]+\/configuration$/.test(path)) return 'board_configuration';
  if (/^\/rest\/api\/2\/issue\/[^/]+\/changelog$/.test(path)) return 'issue_changelog';
  if (/^\/rest\/api\/2\/issue\/[^/]+$/.test(path)) return 'issue_detail';
  if (path === '/rest/api/2/search') return 'jql_search';
  if (path === '/rest/api/2/status') return 'status_list';
  return 'other';
}

function metricsErrorType(error: unknown): string | undefined {
  return error instanceof Error && error.name ? error.name : undefined;
}

export class JiraClient {
  private readonly limiter = pLimit(CONCURRENCY_LIMIT);
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly pat: string,
  ) {
    // Normalize base URL: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async get<T>(path: string, options: FetchOptions = {}): Promise<T> {
    const url = new URL(path, this.baseUrl + '/');
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        url.searchParams.set(k, String(v));
      }
    }

    return this.limiter(() =>
      pRetry(
        async () => {
          const operation = jiraOperation(path);
          const requestStartedAt = metricsClock.now();
          let response: Response;
          try {
            response = await fetch(url.toString(), {
              headers: {
                Authorization: `Bearer ${this.pat}`,
                Accept: 'application/json',
              },
            });
          } catch (error) {
            const errorType = metricsErrorType(error);
            recordJiraRequest({
              method: 'GET',
              url,
              operation,
              result: 'network_error',
              durationSeconds: metricsClock.durationSecondsSince(requestStartedAt),
              ...(errorType === undefined ? {} : { errorType }),
            });
            throw error;
          }

          recordJiraRequest({
            method: 'GET',
            url,
            operation,
            result: response.ok ? 'success' : response.status === 429 ? 'rate_limited' : 'error',
            statusCode: response.status,
            durationSeconds: metricsClock.durationSecondsSince(requestStartedAt),
          });

          if (response.status === 429) {
            const retryAfter = Number(response.headers.get('Retry-After') ?? 10);
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
            // Throw a regular error so p-retry will retry
            throw new Error(`Rate limited — retry after ${retryAfter}s`);
          }

          if (!response.ok) {
            const body = await response.text().catch(() => '');
            const truncated = body.slice(0, 200);

            if (response.status === 401 || response.status === 403) {
              throw new AbortError(
                new JiraClientError(
                  `Jira auth error ${response.status}: ${truncated}`,
                  response.status,
                  response.status === 401 ? 'unauthorized' : 'forbidden',
                ),
              );
            }
            if (response.status === 404) {
              throw new AbortError(
                new JiraClientError(`Jira resource not found: ${truncated}`, 404, 'not_found'),
              );
            }

            throw new JiraClientError(
              `Jira API error ${response.status}: ${truncated}`,
              response.status,
              'http_error',
            );
          }

          return response.json() as Promise<T>;
        },
        {
          retries: RETRY_ATTEMPTS,
          onFailedAttempt: (err) => {
            // Abort errors propagate immediately via AbortError above
            if (err instanceof AbortError) return;
          },
        },
      ),
    );
  }

  /**
   * Validate the PAT by checking Jira identity and Agile board access.
   * Returns server info on success; throws JiraClientError on failure.
   */
  async validateConnection(): Promise<JiraServerInfo> {
    // Verify identity
    const myself = await this.get<{ accountId?: string; name?: string }>('/rest/api/2/myself');
    if (!myself.accountId && !myself.name) {
      throw new JiraClientError('PAT authentication did not return a user identity', 401, 'unauthorized');
    }

    // Verify Agile board access (needed for board discovery and sync)
    await this.get('/rest/agile/1.0/board', { params: { type: 'kanban', maxResults: 1 } });

    // Fetch server version metadata
    const serverInfo = await this.get<{ version: string; deploymentType?: string; baseUrl: string }>(
      '/rest/api/2/serverInfo',
    );

    return {
      version: serverInfo.version,
      deploymentType: serverInfo.deploymentType ?? 'Server',
      baseUrl: serverInfo.baseUrl,
    };
  }
}

export function createJiraClient(baseUrl: string, pat: string): JiraClient {
  return new JiraClient(baseUrl, pat);
}
