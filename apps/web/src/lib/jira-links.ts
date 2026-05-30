export function buildJiraBoardUrl(jiraBaseUrl: string, boardId: number | string): string {
  const baseUrl = new URL(jiraBaseUrl);
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('Jira base URL must use http or https.');
  }
  baseUrl.search = '';
  baseUrl.hash = '';
  if (!baseUrl.pathname.endsWith('/')) {
    baseUrl.pathname = `${baseUrl.pathname}/`;
  }

  const url = new URL('secure/RapidBoard.jspa', baseUrl);
  url.searchParams.set('rapidView', String(boardId));
  return url.toString();
}
