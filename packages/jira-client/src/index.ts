export {
  JiraClient,
  JiraClientError,
  createJiraClient,
  inferChangelogFetchStrategyFromServerInfo,
  normalizeChangelogFetchStrategy,
} from './client.js';
export type {
  JiraChangelogFetchStrategy,
  JiraClientOptions,
  JiraServerInfo,
  FetchOptions,
} from './client.js';

export { listBoards, getBoardDetail, getBoardDetailWithFilterId, getBoardFilterId } from './discovery.js';

export { fetchBoardIssues, streamBoardIssues, fetchIssueChangelog, streamJqlIssues } from './issues.js';
export type {
  RawJiraIssue,
  RawJiraIssueFields,
  ChangelogHistory,
  ChangelogItem,
  FetchBoardIssuesOptions,
  FetchBoardIssuesResult,
  StreamJqlIssuesOptions,
} from './issues.js';
