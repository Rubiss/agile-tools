import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ForecastCachePayload } from '@agile-tools/shared/contracts/forecast';
import type { ResolvedSampleWindow } from '@agile-tools/shared';

export interface ForecastCacheKeyInput {
  type: 'when' | 'how_many';
  sampleWindow: ResolvedSampleWindow;
  iterations: number;
  confidenceLevels: number[];
  remainingStoryCount?: number;
  targetDate?: string;
}

/**
 * Compute a stable SHA-256 request hash for a given set of forecast inputs.
 *
 * confidence levels are sorted before hashing so that [50, 85] and [85, 50]
 * produce the same hash key.
 */
export function computeForecastRequestHash(input: ForecastCacheKeyInput): string {
  const normalized = JSON.stringify({
    type: input.type,
    sampleWindow: input.sampleWindow,
    iterations: input.iterations,
    confidenceLevels: [...input.confidenceLevels].sort((a, b) => a - b),
    ...(input.remainingStoryCount !== undefined && {
      remainingStoryCount: input.remainingStoryCount,
    }),
    ...(input.targetDate !== undefined && { targetDate: input.targetDate }),
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export interface ForecastCacheHit {
  payload: ForecastCachePayload;
  sampleSize: number;
}

/**
 * Look up a cached forecast result by scope, request hash, and dataVersion.
 *
 * Returns null when:
 *  - no matching cache entry exists
 *  - the entry has expired
 *
 * Returns the payload and sampleSize so callers can reconstruct the full
 * ForecastResponse without querying throughput data again.
 */
export async function lookupForecastCache(
  db: PrismaClient,
  scopeId: string,
  requestHash: string,
  dataVersion: string,
): Promise<ForecastCacheHit | null> {
  const record = await db.forecastResultCache.findFirst({
    where: {
      scopeId,
      requestHash,
      dataVersion,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (!record) return null;
  return {
    payload: record.resultPayload as unknown as ForecastCachePayload,
    sampleSize: record.sampleSize,
  };
}

export interface StoreForecastCacheInput {
  scopeId: string;
  requestHash: string;
  sampleWindow: ResolvedSampleWindow;
  iterations: number;
  confidenceLevels: number[];
  sampleSize: number;
  dataVersion: string;
  payload: ForecastCachePayload;
  expiresAt?: Date;
}

/**
 * Persist a forecast result in the cache.
 *
 * Uses upsert so that a cache entry created concurrently by another request
 * for the same (scopeId, requestHash, dataVersion) is simply overwritten rather
 * than causing a unique-constraint violation.
 */
export async function storeForecastCache(
  db: PrismaClient,
  input: StoreForecastCacheInput,
): Promise<void> {
  const payloadJson = input.payload as unknown as Prisma.InputJsonValue;
  const warningsJson = input.payload.warnings as unknown as Prisma.InputJsonValue;

  const createData: Prisma.ForecastResultCacheUncheckedCreateInput = {
    scopeId: input.scopeId,
    requestHash: input.requestHash,
    sampleMode: input.sampleWindow.sampleMode,
    historicalWindowDays:
      input.sampleWindow.sampleMode === 'rolling'
        ? input.sampleWindow.historicalWindowDays
        : null,
    sampleStartDate: input.sampleWindow.sampleStartDate,
    sampleEndDate: input.sampleWindow.sampleEndDate,
    iterations: input.iterations,
    confidenceLevels: input.confidenceLevels,
    sampleSize: input.sampleSize,
    dataVersion: input.dataVersion,
    warnings: warningsJson,
    resultPayload: payloadJson,
    ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
  };

  await db.forecastResultCache.upsert({
    where: {
      scopeId_requestHash_dataVersion: {
        scopeId: input.scopeId,
        requestHash: input.requestHash,
        dataVersion: input.dataVersion,
      },
    },
    create: createData,
    update: {
      warnings: warningsJson,
      resultPayload: payloadJson,
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
    },
  });
}
