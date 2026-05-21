import { notFound } from 'next/navigation';
import { getPrismaClient, listSyncRuns } from '@agile-tools/db';
import { InvalidTimeZoneError, normalizeTimeZoneOrThrow } from '@agile-tools/shared';
import { getWorkspaceContext } from '@/server/auth';
import { buildScopeSummary } from '@/server/views/scope-summary';
import { TriggerSyncButton } from '@/components/admin/trigger-sync-button';
import { HoldDefinitionForm } from '@/components/admin/hold-definition-form';
import { FlowAnalyticsSection } from '@/components/flow/flow-analytics-section';
import { AuthRequiredPanel } from '@/components/app/auth-required-panel';
import { ViewerLocalTime } from '@/components/app/viewer-local-time';
import {
  type FlowScope,
  type ScopeSummary,
} from '@agile-tools/shared/contracts/api';
import {
  codeStyle,
  eyebrowStyle,
  heroCardStyle,
  heroCopyStyle,
  heroTitleStyle,
  noticeStyle,
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
  linkStyle,
  insetPanelStyle,
  palette,
} from '@/components/app/chrome';

export function formatScopeIssueTypes(
  scope: Pick<FlowScope, 'includedIssueTypeIds' | 'includedIssueTypes'>,
  filterOptions?: ScopeSummary['filterOptions'],
): string {
  const filterIssueTypesById = new Map(
    (filterOptions?.issueTypes ?? []).map((issueType) => [issueType.id, issueType.name]),
  );
  const persistedIssueTypesById = new Map(
    (scope.includedIssueTypes ?? []).map((issueType) => [issueType.id, issueType.name]),
  );

  return scope.includedIssueTypeIds
    .map((issueTypeId) => {
      const persistedName = persistedIssueTypesById.get(issueTypeId);
      if (persistedName && persistedName !== issueTypeId) {
        return persistedName;
      }
      return filterIssueTypesById.get(issueTypeId) ?? persistedName ?? issueTypeId;
    })
    .join(', ');
}

export function formatScopeTimestamp(
  timestamp: string,
  timeZone: string,
  locale = 'en-US',
): string {
  try {
    const normalizedTimeZone = normalizeTimeZoneOrThrow(timeZone);
    return new Intl.DateTimeFormat(locale, {
      timeZone: normalizedTimeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(timestamp));
  } catch (err) {
    if (err instanceof InvalidTimeZoneError) {
      const fallbackTimestamp = new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(timestamp));
      return `${fallbackTimestamp} (invalid scope timezone: ${timeZone})`;
    }
    throw err;
  }
}

export function formatScopeTimestampParts(
  timestamp: string,
  timeZone: string,
  locale = 'en-US',
): Intl.DateTimeFormatPart[] {
  const normalizedTimeZone = normalizeTimeZoneOrThrow(timeZone);
  return new Intl.DateTimeFormat(locale, {
    timeZone: normalizedTimeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(new Date(timestamp));
}

export default async function ScopePage({
  params,
}: {
  params: Promise<{ scopeId: string }>;
}) {
  const { scopeId } = await params;
  const ctx = await getWorkspaceContext();

  if (!ctx) {
    return (
      <AuthRequiredPanel
        title="Scope analytics require a workspace session"
        description="This route only works inside a workspace context. In local development you can seed a demo workspace and land straight back on this scope."
        demoNextPath={`/scopes/${scopeId}`}
        adminNextPath="/admin/jira"
      />
    );
  }

  const db = getPrismaClient();
  const [summary, latestSyncRuns] = await Promise.all([
    buildScopeSummary(ctx.workspaceId, scopeId),
    listSyncRuns(db, ctx.workspaceId, scopeId, 1),
  ]);
  if (!summary) notFound();

  const { scope, connectionHealth, lastSync, filterOptions, warnings } = summary;
  const latestSync = latestSyncRuns[0];
  const activeSync =
    latestSync !== undefined
    && (latestSync.status === 'queued' || latestSync.status === 'running')
      ? latestSync
      : null;
  const displayedSyncStatus = activeSync?.status ?? lastSync?.status;
  const displayedSyncErrorCode = activeSync ? activeSync.errorCode : lastSync?.errorCode;
  const displayedSyncErrorSummary = activeSync ? activeSync.errorSummary : lastSync?.errorSummary;

  const healthColor: Record<string, string> = {
    healthy: palette.positive,
    unhealthy: palette.danger,
    stale: palette.warning,
    validating: palette.accentStrong,
    draft: palette.soft,
    disabled: palette.soft,
  };

  const connectionTone = connectionHealth === 'healthy'
    ? 'positive'
    : connectionHealth === 'stale'
      ? 'warning'
      : connectionHealth === 'unhealthy'
        ? 'danger'
        : connectionHealth === 'validating'
          ? 'info'
          : 'neutral';

  const scopeTone = scope.status === 'active'
    ? 'positive'
    : scope.status === 'paused'
      ? 'warning'
      : scope.status === 'needs_attention'
        ? 'danger'
        : 'neutral';
  const formattedLastSyncAt = lastSync?.finishedAt
    ? formatScopeTimestamp(lastSync.finishedAt, scope.timezone)
    : null;
  const lastSyncFinishedAt = lastSync?.finishedAt ?? null;
  const lastSyncTimeNode = lastSyncFinishedAt && formattedLastSyncAt
    ? (
      <ViewerLocalTime
        timestamp={lastSyncFinishedAt}
        scopeFallback={formattedLastSyncAt}
        scopeTimezone={scope.timezone}
      />
    )
    : null;

  return (
    <main style={pageShellStyle}>
      <section style={heroCardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <p style={eyebrowStyle}>Flow Scope</p>
            <h1 style={heroTitleStyle}>{scope.boardName ?? `Board ${scope.boardId}`}</h1>
            <p style={heroCopyStyle}>
              Track active work, sync health, and aging signals for this board snapshot.
            </p>
            <p style={{ margin: '0.9rem 0 0', color: palette.muted, fontSize: '0.92rem' }}>
              Scope ID <span style={codeStyle}>{scope.id}</span>
            </p>
          </div>
          <span style={tonePillStyle(scopeTone)}>{scope.status}</span>
        </div>

        <div style={statGridStyle}>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Connection Health</p>
            <p style={{ ...statValueStyle, color: healthColor[connectionHealth] ?? palette.ink }}>{connectionHealth}</p>
          </article>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Last Sync</p>
            <p style={{ ...statValueStyle, fontSize: '1rem' }}>
              {lastSyncTimeNode ?? 'No sync yet'}
            </p>
          </article>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Timezone</p>
            <p style={statValueStyle}>{scope.timezone}</p>
          </article>
          <article style={statCardStyle}>
            <p style={statLabelStyle}>Cadence</p>
            <p style={statValueStyle}>Every {scope.syncIntervalMinutes}m</p>
          </article>
        </div>
      </section>

      <div style={sectionStackStyle}>
        {warnings.length > 0 && (
          <section style={noticeStyle('warning')}>
            <strong style={{ display: 'block', marginBottom: '0.35rem' }}>Warnings</strong>
            <div style={{ display: 'grid', gap: '0.45rem' }}>
              {warnings.map((w, i) => (
                <p key={i} style={{ margin: 0 }}>{w.message}</p>
              ))}
            </div>
          </section>
        )}

        <section style={sectionCardStyle}>
          <div style={sectionHeaderRowStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Connection and sync</h2>
              <p style={sectionCopyStyle}>Current health, most recent sync outcome, and the active snapshot identifier.</p>
            </div>
            <span style={tonePillStyle(connectionTone)}>{connectionHealth}</span>
          </div>

        {displayedSyncStatus ? (
          <div style={{ display: 'grid', gap: '0.85rem' }}>
            <div style={insetPanelStyle}>
              <p style={{ margin: 0, color: palette.muted, fontSize: '0.9rem' }}>
                Last sync{' '}
                <strong
                  style={{
                    color:
                      displayedSyncStatus === 'succeeded'
                        ? palette.positive
                        : displayedSyncStatus === 'failed'
                          ? palette.danger
                          : palette.accentStrong,
                  }}
                >
                  {displayedSyncStatus}
                </strong>
                {lastSyncTimeNode && (
                  <span style={{ marginLeft: '0.45rem', color: palette.soft }}>
                    {activeSync ? 'last finished' : 'finished'} {lastSyncTimeNode}
                  </span>
                )}
              </p>
            </div>
            {lastSync?.dataVersion && (
              <div style={insetPanelStyle}>
                <p style={{ margin: 0, color: palette.muted, fontSize: '0.9rem' }}>
                  Data version <span style={codeStyle}>{lastSync.dataVersion}</span>
                </p>
              </div>
            )}
            {displayedSyncErrorCode && (
              <p style={{ margin: 0, color: palette.danger, fontSize: '0.875rem' }}>
                Error: {displayedSyncErrorCode}
                {displayedSyncErrorSummary && ` — ${displayedSyncErrorSummary}`}
              </p>
            )}
          </div>
        ) : (
          <p style={sectionCopyStyle}>No sync runs yet.</p>
        )}
        {ctx.role === 'admin' && <TriggerSyncButton scopeId={scopeId} />}
        </section>

        {filterOptions && (
          <section style={sectionCardStyle}>
            <div style={sectionHeaderRowStyle}>
              <div>
                <h2 style={sectionTitleStyle}>Flow analytics</h2>
                <p style={sectionCopyStyle}>Use the filters to focus the aging view on specific statuses, issue types, or blocked work.</p>
              </div>
            </div>
            <FlowAnalyticsSection
              scopeId={scopeId}
              filterOptions={{
                ...(filterOptions.issueTypes !== undefined && { issueTypes: filterOptions.issueTypes }),
                ...(filterOptions.statuses !== undefined && { statuses: filterOptions.statuses }),
                ...(filterOptions.historicalWindows !== undefined && { historicalWindows: filterOptions.historicalWindows }),
              }}
            />
            {ctx.role === 'admin' && (
              <HoldDefinitionForm
                scopeId={scopeId}
                {...(filterOptions.statuses !== undefined && { availableStatuses: filterOptions.statuses })}
              />
            )}
          </section>
        )}

        <section style={sectionCardStyle}>
          <div style={sectionHeaderRowStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Configuration</h2>
              <p style={sectionCopyStyle}>The scope definition below controls what is included in cycle time, throughput, and forecast calculations.</p>
            </div>
          </div>
          <div style={statGridStyle}>
            <article style={statCardStyle}>
              <p style={statLabelStyle}>Board ID</p>
              <p style={statValueStyle}>{scope.boardId}</p>
            </article>
            <article style={statCardStyle}>
              <p style={statLabelStyle}>Timezone</p>
              <p style={statValueStyle}>{scope.timezone}</p>
            </article>
            <article style={statCardStyle}>
              <p style={statLabelStyle}>Sync Interval</p>
              <p style={statValueStyle}>{scope.syncIntervalMinutes} min</p>
            </article>
            <article style={statCardStyle}>
              <p style={statLabelStyle}>Issue Types</p>
              <p style={{ ...statValueStyle, fontSize: '0.98rem', lineHeight: 1.4 }}>
                {formatScopeIssueTypes(scope, filterOptions)}
              </p>
            </article>
          </div>
        </section>

        <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {ctx.role === 'admin' && (
            <a href="/admin/jira" style={linkStyle}>
              ← Back to Jira Setup
            </a>
          )}
        {filterOptions && (
          <a href={`/scopes/${scopeId}/forecast`} style={linkStyle}>
            📊 Forecast →
          </a>
        )}
        </div>
      </div>
    </main>
  );
}
