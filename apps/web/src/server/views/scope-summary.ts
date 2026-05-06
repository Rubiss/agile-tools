import type { ScopeSummary, Warning } from '@agile-tools/shared/contracts/api';
import {
  getPrismaClient,
  getFlowScope,
  getJiraConnection,
  listSyncRuns,
  getLastSucceededSyncRun,
  queryScopeFilterOptions,
} from '@agile-tools/db';
import { mapScope, mapSyncRun } from '@/app/api/v1/admin/scopes/_lib';

const DEFAULT_HISTORICAL_WINDOWS = [30, 60, 90, 180];

/**
 * Assemble the ScopeSummary response for a given workspace + scope.
 * Returns null when the scope does not exist or does not belong to the workspace.
 */
export async function buildScopeSummary(
  workspaceId: string,
  scopeId: string,
): Promise<ScopeSummary | null> {
  const db = getPrismaClient();

  const scope = await getFlowScope(db, workspaceId, scopeId);
  if (!scope) return null;

  // Run independent queries concurrently
  const [connection, syncRuns, lastSucceeded] = await Promise.all([
    getJiraConnection(db, workspaceId, scope.connectionId),
    listSyncRuns(db, workspaceId, scopeId, 1),
    getLastSucceededSyncRun(db, workspaceId, scopeId),
  ]);

  const lastSync = syncRuns[0];

  // Pin filter options to the latest succeeded sync's published snapshot.
  // Omit filterOptions entirely if no succeeded sync has run yet so the UI
  // can distinguish "not yet synced" from "synced but empty".
  let filterOptions: ScopeSummary['filterOptions'];
  if (lastSucceeded?.dataVersion) {
    const options = await queryScopeFilterOptions(db, scopeId, {
      dataVersion: lastSucceeded.dataVersion,
    });
    filterOptions = {
      issueTypes: options.issueTypes,
      statuses: options.statuses,
      historicalWindows: DEFAULT_HISTORICAL_WINDOWS,
    };
  }

  const warnings: Warning[] = [];
  if (connection?.healthStatus === 'unhealthy') {
    warnings.push({
      code: 'CONNECTION_UNHEALTHY',
      message: 'The Jira connection is unhealthy. Syncs may fail until the connection is re-validated.',
    });
  } else if (connection?.healthStatus === 'stale') {
    warnings.push({
      code: 'CONNECTION_STALE',
      message: 'The Jira connection has not been validated recently and may be stale.',
    });
  }
  if (scope.status === 'needs_attention') {
    warnings.push({
      code: 'BOARD_DRIFT_DETECTED',
      message: 'Board configuration has changed. Review and update the scope boundaries.',
    });
  }

  return {
    scope: mapScope(scope),
    connectionHealth: (connection?.healthStatus ?? 'draft') as ScopeSummary['connectionHealth'],
    ...(lastSync !== undefined ? { lastSync: mapSyncRun(lastSync) } : {}),
    ...(lastSucceeded !== undefined ? { lastSucceededSync: mapSyncRun(lastSucceeded) } : {}),
    ...(filterOptions !== undefined ? { filterOptions } : {}),
    warnings,
  };
}
