import { getPrismaClient, listJiraConnections, listFlowScopes } from '@agile-tools/db';
import { getWorkspaceContext } from '@/server/auth';
import { mapConnection } from '@/app/api/v1/admin/jira-connections/_lib';
import { mapScope } from '@/app/api/v1/admin/scopes/_lib';
import { JiraConnectionForm, ValidateConnectionButton } from '@/components/admin/jira-connection-form';
import { FlowScopeForm } from '@/components/admin/flow-scope-form';
import { AuthRequiredPanel } from '@/components/app/auth-required-panel';
import { Breadcrumbs } from '@/components/app/breadcrumbs';
import {
  codeStyle,
  eyebrowStyle,
  heroCardStyle,
  heroCopyStyle,
  heroTitleStyle,
  itemCardStyle,
  linkStyle,
  listStyle,
  pageShellStyle,
  sectionCardStyle,
  sectionCopyStyle,
  sectionHeaderRowStyle,
  sectionStackStyle,
  sectionTitleStyle,
  statCardStyle,
  statGridStyle,
  statLabelStyle,
  statValueStyle,
  tonePillStyle,
  palette,
} from '@/components/app/chrome';

export default async function AdminJiraPage() {
  const ctx = await getWorkspaceContext();

  if (!ctx) {
    return (
      <AuthRequiredPanel
        title="Jira setup requires a workspace session"
        description="The admin area is guarded by the workspace session cookie. For local hosting you can create a local admin session and continue directly into the setup flow."
        adminNextPath="/admin/jira"
        showDemoBootstrap={false}
      />
    );
  }

  if (ctx.role !== 'admin') {
      return (
        <main style={pageShellStyle}>
          <Breadcrumbs items={[{ label: 'Jira Setup' }]} />
          <section style={sectionCardStyle}>
          <p style={{ ...eyebrowStyle, color: palette.danger }}>Access Control</p>
          <h1 style={{ ...heroTitleStyle, fontSize: '2rem' }}>Administrator access required</h1>
          <p style={heroCopyStyle}>This workspace page is limited to administrators because it can modify Jira connections and scope configuration.</p>
        </section>
      </main>
    );
  }

  const db = getPrismaClient();
  const [connections, scopes] = await Promise.all([
    listJiraConnections(db, ctx.workspaceId),
    listFlowScopes(db, ctx.workspaceId),
  ]);

  const connectionSummaries = connections.map(mapConnection);
  const jiraBaseUrlByConnectionId = new Map(connections.map((connection) => [connection.id, connection.baseUrl]));
  const scopeSummaries = scopes.map((scope) => {
    const jiraBaseUrl = jiraBaseUrlByConnectionId.get(scope.connectionId);
    return mapScope(scope, jiraBaseUrl ? { jiraBaseUrl } : undefined);
  });

  const connectionTone = (status: string) => {
    if (status === 'healthy') return 'positive';
    if (status === 'stale') return 'warning';
    if (status === 'unhealthy') return 'danger';
    if (status === 'validating') return 'info';
    return 'neutral';
  };

  const scopeTone = (status: string) => {
    if (status === 'active') return 'positive';
    if (status === 'paused') return 'warning';
    if (status === 'needs_attention') return 'danger';
    return 'neutral';
  };

  return (
    <main style={pageShellStyle}>
      <Breadcrumbs items={[{ label: 'Jira Setup' }]} />
      <section style={heroCardStyle}>
        <p style={eyebrowStyle}>Workspace Admin</p>
        <h1 style={heroTitleStyle}>Jira setup</h1>
        <p style={heroCopyStyle}>
          Manage Jira connections, validate access, and create, edit, or delete the flow scopes that feed analytics and forecasting.
        </p>
        <div style={statGridStyle}>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Connections</p>
            <p style={statValueStyle}>{connectionSummaries.length}</p>
          </article>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Flow Scopes</p>
            <p style={statValueStyle}>{scopeSummaries.length}</p>
          </article>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Workspace</p>
            <p style={{ ...statValueStyle, fontSize: '1rem' }}>
              <span style={codeStyle}>{ctx.workspaceId}</span>
            </p>
          </article>
        </div>
      </section>

      <div style={sectionStackStyle}>
        <section style={sectionCardStyle}>
          <div style={sectionHeaderRowStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Connections</h2>
              <p style={sectionCopyStyle}>Each connection stores the Jira base URL and PAT used for discovery and sync.</p>
            </div>
          </div>
        {connectionSummaries.length === 0 ? (
          <p style={sectionCopyStyle}>No Jira connections configured yet.</p>
        ) : (
          <ul style={listStyle}>
            {connectionSummaries.map((conn) => (
              <li
                key={conn.id}
                style={itemCardStyle}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div>
                    <strong style={{ display: 'block', fontSize: '1rem', color: palette.ink }}>
                      {conn.displayName ?? conn.baseUrl}
                    </strong>
                    <p style={{ margin: '0.45rem 0 0', color: palette.muted, fontSize: '0.92rem' }}>{conn.baseUrl}</p>
                  </div>
                  <span style={tonePillStyle(connectionTone(conn.healthStatus))}>{conn.healthStatus}</span>
                </div>
                {conn.lastErrorCode && (
                  <p style={{ margin: '0.75rem 0 0', color: palette.warning, fontSize: '0.84rem' }}>
                    Last error: <span style={codeStyle}>{conn.lastErrorCode}</span>
                  </p>
                )}
                <div style={{ marginTop: '0.5rem' }}>
                  <ValidateConnectionButton connectionId={conn.id} />
                </div>
                <JiraConnectionForm
                  key={`connection-${conn.id}-${conn.baseUrl}-${conn.displayName ?? ''}-${conn.healthStatus}`}
                  initialConnection={conn}
                />
              </li>
            ))}
          </ul>
        )}

        <JiraConnectionForm />
        </section>

        <section style={sectionCardStyle}>
          <div style={sectionHeaderRowStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Flow scopes</h2>
              <p style={sectionCopyStyle}>Scopes define the board, issue types, start states, and done states used to build projections.</p>
            </div>
          </div>
        {scopeSummaries.length === 0 ? (
          <p style={sectionCopyStyle}>No flow scopes configured yet.</p>
        ) : (
          <ul style={listStyle}>
            {scopeSummaries.map((scope) => (
              <li
                key={scope.id}
                style={{ ...itemCardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}
              >
                <div>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ color: palette.ink }}>{scope.boardName ?? `Board ${scope.boardId}`}</strong>
                    <span style={tonePillStyle(scopeTone(scope.status))}>{scope.status}</span>
                  </div>
                  <p style={{ margin: '0.45rem 0 0', color: palette.muted, fontSize: '0.92rem' }}>
                    Board {scope.boardId} · every {scope.syncIntervalMinutes} minutes
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <a href={`/scopes/${scope.id}`} style={linkStyle}>
                    View →
                  </a>
                  {scope.jiraDashboardUrl && (
                    <a
                      href={scope.jiraDashboardUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={linkStyle}
                    >
                      Jira dashboard ↗
                    </a>
                  )}
                </div>
                <div style={{ width: '100%' }}>
                  <FlowScopeForm
                    key={`scope-${scope.id}-${scope.connectionId}-${scope.boardId}-${scope.timezone}-${scope.syncIntervalMinutes}`}
                    connections={connectionSummaries}
                    initialScope={scope}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {connectionSummaries.length > 0 && (
          <FlowScopeForm connections={connectionSummaries} />
        )}
        {connectionSummaries.length === 0 && (
          <p style={sectionCopyStyle}>
            Add a Jira connection before creating a flow scope.
          </p>
        )}
        </section>
      </div>
    </main>
  );
}
