import { describe, expect, it } from 'vitest';

import { buildJiraBoardUrl } from './jira-links';

describe('buildJiraBoardUrl', () => {
  it('builds a Jira board dashboard URL from a base URL and board ID', () => {
    expect(buildJiraBoardUrl('https://jira.example.internal', 42)).toBe(
      'https://jira.example.internal/secure/RapidBoard.jspa?rapidView=42',
    );
  });

  it('preserves Jira base paths', () => {
    expect(buildJiraBoardUrl('https://jira.example.internal/jira/', '7')).toBe(
      'https://jira.example.internal/jira/secure/RapidBoard.jspa?rapidView=7',
    );
  });
});
