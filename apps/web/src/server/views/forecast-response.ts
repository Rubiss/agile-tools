import type { ForecastResponse, ForecastRequest } from '@agile-tools/shared/contracts/forecast';
import type { MonteCarloForecastResult } from '@agile-tools/analytics';
import type { ResolvedSampleWindow } from '@agile-tools/shared';

export interface ShapeForecastResponseInput {
  scopeId: string;
  request: ForecastRequest;
  sampleWindow: ResolvedSampleWindow;
  /** The resolved data snapshot identifier pinned to this forecast. */
  dataVersion: string;
  /** Number of completed stories in the historical sample. */
  sampleSize: number;
  /** Number of Monte Carlo iterations run. */
  iterations: number;
  monteCarlo: MonteCarloForecastResult;
}

/**
 * Shape a ForecastResponse from resolved forecast parameters and Monte Carlo output.
 *
 * This pure function is shared between the cache-hit path (where the Monte Carlo
 * results come from storage) and the fresh-compute path (where they come directly
 * from the engine). Warnings from the Monte Carlo engine are forwarded verbatim so
 * callers always receive LOW_SAMPLE_SIZE or NO_THROUGHPUT_HISTORY signals when the
 * data does not support confident forecasting.
 *
 * The `dataVersion` field in the response lets clients pin subsequent requests to the
 * same sync snapshot, ensuring reproducible results even as new syncs arrive.
 */
export function shapeForecastResponse(input: ShapeForecastResponseInput): ForecastResponse {
  const { scopeId, request, sampleWindow, dataVersion, sampleSize, iterations, monteCarlo } = input;

  return {
    scopeId,
    dataVersion,
    type: request.type,
    ...sampleWindow,
    sampleSize,
    iterations,
    warnings: monteCarlo.warnings,
    results: monteCarlo.results,
  };
}
