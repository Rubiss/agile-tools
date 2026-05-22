import type { RawJiraIssue, ChangelogHistory } from '@agile-tools/jira-client';

export interface NormalizeContext {
  scopeId: string;
  syncRunId: string;
  startStatusIds: Set<string>;
  doneStatusIds: Set<string>;
  includedIssueTypeIds: Set<string>;
  /** Inverted lookup: statusId → column name from the board configuration. */
  statusIdsByColumn: Record<string, string>;
  jiraBaseUrl: string;
}

export interface NormalizedLifecycleEvent {
  rawChangelogId: string;
  eventType: 'status_change' | 'field_change' | 'reopened' | 'completed';
  fromStatusId: string | null;
  toStatusId: string | null;
  changedFieldId: string | null;
  changedAt: Date;
}

export interface NormalizedWorkItem {
  jiraIssueId: string;
  issueKey: string;
  summary: string;
  issueTypeId: string;
  issueTypeName: string;
  projectId: string;
  currentStatusId: string;
  currentStatusName: string;
  currentColumn: string | null;
  assigneeName: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  reopenedCount: number;
  directUrl: string;
  /** Set to 'issue_type_excluded' if not in includedIssueTypeIds; null otherwise. */
  excludedReason: string | null;
  lifecycleEvents: NormalizedLifecycleEvent[];
}

export function normalizeJiraIssue(
  issue: RawJiraIssue,
  changelog: ChangelogHistory[],
  ctx: NormalizeContext,
): NormalizedWorkItem {
  const { fields } = issue;
  const currentStatusId = fields.status.id;
  const assigneeName = fields.assignee?.name ?? fields.assignee?.accountId ?? null;

  const excludedReason = !ctx.includedIssueTypeIds.has(fields.issuetype.id)
    ? 'issue_type_excluded'
    : null;

  const lifecycleEvents = deriveLifecycleEvents(changelog, ctx);
  const createdAt = new Date(fields.created);
  const { startedAt, completedAt } = deriveTimestamps(
    lifecycleEvents,
    currentStatusId,
    createdAt,
    ctx,
  );
  const reopenedCount = lifecycleEvents.filter((e) => e.eventType === 'reopened').length;

  return {
    jiraIssueId: issue.id,
    issueKey: issue.key,
    summary: fields.summary,
    issueTypeId: fields.issuetype.id,
    issueTypeName: fields.issuetype.name,
    projectId: fields.project.id,
    currentStatusId,
    currentStatusName: fields.status.name,
    currentColumn: ctx.statusIdsByColumn[currentStatusId] ?? null,
    assigneeName,
    createdAt,
    startedAt,
    completedAt,
    reopenedCount,
    directUrl: `${ctx.jiraBaseUrl}/browse/${issue.key}`,
    excludedReason,
    lifecycleEvents,
  };
}

/**
 * Derive lifecycle events from Jira changelog histories.
 *
 * Rules:
 * - Each status field change produces a `status_change` event.
 * - Entering a done status (not from another done status) also produces a `completed` event.
 * - Leaving a done status (to a non-done status) also produces a `reopened` event.
 * - At most one `field_change` event is emitted per history entry due to the DB unique
 *   constraint on (workItemId, rawChangelogId, eventType). Only the first non-status field
 *   with a fieldId is recorded.
 */
function deriveLifecycleEvents(
  histories: ChangelogHistory[],
  ctx: NormalizeContext,
): NormalizedLifecycleEvent[] {
  const events: NormalizedLifecycleEvent[] = [];

  const sorted = [...histories].sort(
    (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime(),
  );

  for (const history of sorted) {
    const changedAt = new Date(history.created);
    let fieldChangeEmitted = false;

    for (const item of history.items) {
      if (item.field === 'status') {
        const fromId = item.from ?? null;
        const toId = item.to ?? null;

        events.push({
          rawChangelogId: history.id,
          eventType: 'status_change',
          fromStatusId: fromId,
          toStatusId: toId,
          changedFieldId: null,
          changedAt,
        });

        const enteringDone = toId != null && ctx.doneStatusIds.has(toId);
        const leavingDone = fromId != null && ctx.doneStatusIds.has(fromId);

        if (enteringDone && !leavingDone) {
          events.push({
            rawChangelogId: history.id,
            eventType: 'completed',
            fromStatusId: fromId,
            toStatusId: toId,
            changedFieldId: null,
            changedAt,
          });
        } else if (leavingDone && !enteringDone) {
          events.push({
            rawChangelogId: history.id,
            eventType: 'reopened',
            fromStatusId: fromId,
            toStatusId: toId,
            changedFieldId: null,
            changedAt,
          });
        }
      } else if (!fieldChangeEmitted && item.fieldId != null) {
        // One field_change per history entry (DB unique constraint: workItemId, rawChangelogId, eventType)
        events.push({
          rawChangelogId: history.id,
          eventType: 'field_change',
          fromStatusId: null,
          toStatusId: null,
          changedFieldId: item.fieldId,
          changedAt,
        });
        fieldChangeEmitted = true;
      }
    }
  }

  return events;
}

/**
 * Derive startedAt and completedAt from lifecycle events.
 *
 * - startedAt: earliest transition into a startStatusId. If no such transition
 *   exists but the item's current status is a start status (e.g., the issue
 *   was created directly in a start status with no changelog entry), fall back
 *   to the issue's createdAt so the item is still treated as in-flow by
 *   downstream projections (flow chart, filter dropdowns, aging thresholds).
 * - completedAt: timestamp of the latest `completed` event, but only when the
 *   item's current status is a done status (i.e., it has not been re-opened
 *   since its last completion). Items that never had a recorded `completed`
 *   event will have completedAt = null even if they are currently in a done
 *   status (e.g., created directly in done with no changelog).
 */
function deriveTimestamps(
  events: NormalizedLifecycleEvent[],
  currentStatusId: string,
  createdAt: Date,
  ctx: NormalizeContext,
): { startedAt: Date | null; completedAt: Date | null } {
  const startEvents = events.filter(
    (e) =>
      e.eventType === 'status_change' &&
      e.toStatusId != null &&
      ctx.startStatusIds.has(e.toStatusId),
  );
  const startedAt =
    startEvents.length > 0
      ? startEvents[0]!.changedAt
      : ctx.startStatusIds.has(currentStatusId)
        ? createdAt
        : null;

  let completedAt: Date | null = null;
  if (ctx.doneStatusIds.has(currentStatusId)) {
    const completedEvents = events.filter((e) => e.eventType === 'completed');
    if (completedEvents.length > 0) {
      completedAt = completedEvents[completedEvents.length - 1]!.changedAt;
    }
  }

  return { startedAt, completedAt };
}
