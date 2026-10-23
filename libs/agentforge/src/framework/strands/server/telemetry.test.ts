import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TELEMETRY_LEVELS } from '#core/telemetry.ts';
import {
  STRANDS_COLLECTOR_CONFIG,
  strandsTelemetryEnvironment,
} from './telemetry.ts';

const ENDPOINT = 'http://127.0.0.1:4318';

describe('strandsTelemetryEnvironment', () => {
  it('exports metrics at WARN, and no traces', () => {
    const environment = strandsTelemetryEnvironment('WARN', ENDPOINT);
    expect(environment).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
    });
  });

  it.each(['INFO', 'DEBUG', 'ALL'] as const)('adds traces at %s', (level) => {
    expect(
      strandsTelemetryEnvironment(level, ENDPOINT).OTEL_TRACES_EXPORTER,
    ).toBe('otlp');
  });

  it('names a collector configuration that exists at every level', () => {
    for (const level of TELEMETRY_LEVELS) {
      for (const url of STRANDS_COLLECTOR_CONFIG[level]) {
        expect(existsSync(fileURLToPath(url))).toBe(true);
      }
    }
  });
});
