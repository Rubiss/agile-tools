import type {
  EpicForecastTargetStatus,
  EpicStoryCountSource,
} from '@agile-tools/shared/contracts/epic-forecast';
import type { PrismaClient } from '@prisma/client';

export interface EpicForecastTargetRow {
  id: string;
  scopeId: string;
  jiraIssueKey: string;
  summary: string;
  dueDate: string;
  remainingStoryCount: number;
  storyCountSource: EpicStoryCountSource;
  epicLinkStoryCount: number | null;
  jiraStoryCount: number | null;
  manualStoryCount: number | null;
  status: EpicForecastTargetStatus;
  closedAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertEpicForecastTargetInput {
  scopeId: string;
  jiraIssueKey: string;
  summary: string;
  dueDate: string;
  remainingStoryCount: number;
  storyCountSource?: EpicStoryCountSource;
  epicLinkStoryCount?: number | null;
  jiraStoryCount?: number | null;
  manualStoryCount?: number | null;
  status?: EpicForecastTargetStatus;
  closedAt?: Date | null;
  sortOrder?: number;
}

export async function listEpicForecastTargets(
  db: PrismaClient,
  scopeId: string,
): Promise<EpicForecastTargetRow[]> {
  return db.epicForecastTarget.findMany({
    where: { scopeId },
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { sortOrder: 'asc' }, { jiraIssueKey: 'asc' }],
  }) as Promise<EpicForecastTargetRow[]>;
}

export async function upsertEpicForecastTarget(
  db: PrismaClient,
  input: UpsertEpicForecastTargetInput,
): Promise<EpicForecastTargetRow> {
  return db.epicForecastTarget.upsert({
    where: {
      scopeId_jiraIssueKey: {
        scopeId: input.scopeId,
        jiraIssueKey: input.jiraIssueKey,
      },
    },
    create: {
      scopeId: input.scopeId,
      jiraIssueKey: input.jiraIssueKey,
      summary: input.summary,
      dueDate: input.dueDate,
      remainingStoryCount: input.remainingStoryCount,
      storyCountSource: input.storyCountSource ?? 'manual',
      epicLinkStoryCount: input.epicLinkStoryCount ?? null,
      jiraStoryCount: input.jiraStoryCount ?? null,
      manualStoryCount: input.manualStoryCount ?? input.remainingStoryCount,
      status: input.status ?? 'active',
      closedAt: input.closedAt ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
    update: {
      summary: input.summary,
      dueDate: input.dueDate,
      remainingStoryCount: input.remainingStoryCount,
      storyCountSource: input.storyCountSource ?? 'manual',
      epicLinkStoryCount: input.epicLinkStoryCount ?? null,
      jiraStoryCount: input.jiraStoryCount ?? null,
      manualStoryCount: input.manualStoryCount ?? input.remainingStoryCount,
      status: input.status ?? 'active',
      closedAt: input.closedAt ?? null,
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  }) as Promise<EpicForecastTargetRow>;
}

export async function deleteEpicForecastTarget(
  db: PrismaClient,
  scopeId: string,
  targetId: string,
): Promise<boolean> {
  const deleted = await db.epicForecastTarget.deleteMany({
    where: { id: targetId, scopeId },
  });
  return deleted.count > 0;
}
