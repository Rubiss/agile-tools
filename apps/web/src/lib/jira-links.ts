export function buildJiraBoardUrl(jiraBaseUrl: string, boardId: number | string): string {
  const trimmedBaseUrl = jiraBaseUrl.endsWith('/') ? jiraBaseUrl.slice(0, -1) : jiraBaseUrl;
  const url = new URL(`${trimmedBaseUrl}/secure/RapidBoard.jspa`);
  url.searchParams.set('rapidView', String(boardId));
  return url.toString();
}
