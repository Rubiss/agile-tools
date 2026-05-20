import { getPrismaClient, listFlowScopes, listJiraConnections } from '@agile-tools/db';
import { getWorkspaceContext } from '@/server/auth';
import { getLocalDemoDefaultPath, isLocalDemoEnabled } from '@/server/dev-demo';
import { getLocalAdminDefaultPath, isLocalAdminBootstrapAvailable } from '@/server/local-bootstrap';
import { LocalBootstrapForm } from '@/components/app/demo-bootstrap-form';
import {
  buttonStyle,
  codeStyle,
  eyebrowStyle,
  heroCardStyle,
  heroCopyStyle,
  heroTitleStyle,
  itemCardStyle,
  linkStyle,
  pageShellStyle,
  palette,
  sectionCardStyle,
  sectionCopyStyle,
  sectionStackStyle,
  sectionTitleStyle,
  statCardStyle,
  statGridStyle,
  statLabelStyle,
  statValueStyle,
} from '@/components/app/chrome';

export default async function HomePage() {
  const ctx = await getWorkspaceContext();
  const demoEnabled = isLocalDemoEnabled();
  const adminBootstrapEnabled = isLocalAdminBootstrapAvailable();

  if (!ctx) {
    return (
      <main style={{ ...pageShellStyle, maxWidth: '1040px' }}>
        <section style={heroCardStyle}>
          <p style={eyebrowStyle}>
            Local Entry
          </p>
          <h1 style={heroTitleStyle}>Kanban flow analytics and forecasting</h1>
          <p style={heroCopyStyle}>
            The working app routes in this feature are the Jira setup page, the scope analytics page, and the forecast page underneath a scope. This landing page exists to make local development and local image hosting usable when no workspace session is present yet.
          </p>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1.5rem' }}>
            {demoEnabled && (
              <LocalBootstrapForm
                label="Open seeded demo scope →"
                nextPath={getLocalDemoDefaultPath()}
                mode="demo"
              />
            )}
            {adminBootstrapEnabled && (
              <LocalBootstrapForm
                label="Create local admin session and open Jira setup"
                nextPath={getLocalAdminDefaultPath()}
                mode="admin"
                variant={demoEnabled ? 'secondary' : 'primary'}
              />
            )}
          </div>
        </section>

        <section style={statGridStyle}>
          {[
            {
              title: 'Jira Setup',
              href: '/admin/jira',
              description: 'Connections, validation, and flow scope creation.',
            },
            ...(demoEnabled
              ? [
                  {
                    title: 'Scope Analytics',
                    href: getLocalDemoDefaultPath(),
                    description: 'Connection health, sync status, aging scatter plot, and hold rules.',
                  },
                  {
                    title: 'Forecast',
                    href: `${getLocalDemoDefaultPath()}/forecast`,
                    description: 'Historical throughput plus Monte Carlo forecasts.',
                  },
                ]
              : []),
          ].map((entry) => (
            <a
              key={entry.title}
              href={entry.href}
              style={{
                ...itemCardStyle,
                display: 'block',
                textDecoration: 'none',
                color: palette.text,
              }}
            >
              <h2 style={{ ...sectionTitleStyle, fontSize: '1.3rem' }}>{entry.title}</h2>
              <p style={{ ...sectionCopyStyle, marginTop: '0.5rem' }}>{entry.description}</p>
            </a>
          ))}
        </section>
      </main>
    );
  }

  const db = getPrismaClient();
  const [workspace, connections, scopes] = await Promise.all([
    db.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { name: true, defaultTimezone: true },
    }),
    listJiraConnections(db, ctx.workspaceId),
    listFlowScopes(db, ctx.workspaceId),
  ]);

  return (
    <main style={{ ...pageShellStyle, maxWidth: '1040px' }}>
      <section style={heroCardStyle}>
        <p style={eyebrowStyle}>
          Workspace Home
        </p>
        <h1 style={heroTitleStyle}>
          {workspace?.name ?? 'Agile Tools'}
        </h1>
        <p style={heroCopyStyle}>
          Signed in as {ctx.role} for workspace <span style={codeStyle}>{ctx.workspaceId}</span>.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1.25rem' }}>
          {ctx.role === 'admin' && (
            <a
              href="/admin/jira"
              style={{
                ...buttonStyle('primary'),
                display: 'inline-flex',
                alignItems: 'center',
                textDecoration: 'none',
              }}
            >
              Open Jira setup
            </a>
          )}
          {demoEnabled && (
            <LocalBootstrapForm
              label="Reset local demo data"
              nextPath={getLocalDemoDefaultPath()}
              mode="demo"
              variant="secondary"
            />
          )}
        </div>
      </section>

      <section style={statGridStyle}>
        <article style={statCardStyle}>
          <p style={statLabelStyle}>Connections</p>
          <p style={statValueStyle}>{connections.length}</p>
        </article>
        <article style={statCardStyle}>
          <p style={statLabelStyle}>Scopes</p>
          <p style={statValueStyle}>{scopes.length}</p>
        </article>
        <article style={statCardStyle}>
          <p style={statLabelStyle}>Timezone</p>
          <p style={{ ...statValueStyle, fontSize: '1.2rem' }}>{workspace?.defaultTimezone ?? 'Unknown'}</p>
        </article>
      </section>

      <section style={{ ...sectionCardStyle, marginTop: '1.5rem' }}>
        <h2 style={sectionTitleStyle}>Available scopes</h2>
        {scopes.length === 0 ? (
          <p style={sectionCopyStyle}>No scopes are configured in this workspace yet.</p>
        ) : (
          <div style={sectionStackStyle}>
            {scopes.map((scope) => (
              <div
                key={scope.id}
                style={{
                  ...itemCardStyle,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <h3 style={{ ...sectionTitleStyle, fontSize: '1.2rem' }}>{scope.boardName}</h3>
                  <p style={{ ...sectionCopyStyle, marginTop: '0.5rem' }}>
                    Board {scope.boardId} · every {scope.syncIntervalMinutes} minutes · {scope.status}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <a href={`/scopes/${scope.id}`} style={linkStyle}>
                    Scope →
                  </a>
                  <a href={`/scopes/${scope.id}/forecast`} style={linkStyle}>
                    Forecast →
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
