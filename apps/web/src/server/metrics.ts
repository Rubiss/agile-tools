import {
  collectPrometheusMetrics,
  initializeMetrics as initializeSharedMetrics,
  PROMETHEUS_CONTENT_TYPE,
} from '@agile-tools/shared';

export { collectPrometheusMetrics, PROMETHEUS_CONTENT_TYPE };

export function initializeMetrics(): void {
  initializeSharedMetrics({ serviceName: 'agile-tools-web', runtime: 'web' });
}