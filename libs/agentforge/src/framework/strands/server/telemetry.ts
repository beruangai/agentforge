import { type TelemetryLevel, TelemetryLevelEnum } from '#core/telemetry.ts';

/**
 * What a `strands` task process exports at each level (§REQ602): metrics at
 * every level, and Strands' own `gen_ai.*` spans from `INFO`, each to the
 * collector, which needs no remapping. The runner reads the exporters named
 * here, and flushes them before its task process exits.
 */
export function strandsTelemetryEnvironment(
  level: TelemetryLevel,
  collectorEndpoint: string,
): Record<string, string> {
  const atLeast = (floor: TelemetryLevel): boolean =>
    TelemetryLevelEnum.options.indexOf(level) >=
    TelemetryLevelEnum.options.indexOf(floor);
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: collectorEndpoint,
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    ...(atLeast('INFO') && { OTEL_TRACES_EXPORTER: 'otlp' }),
  };
}

const collector = (name: string): URL =>
  new URL(`./collector/${name}`, import.meta.url);

/** The collector's configuration, the same at every level: the level is the task process's. */
export const STRANDS_COLLECTOR_CONFIG: Readonly<
  Record<TelemetryLevel, readonly URL[]>
> = {
  WARN: [collector('collector.yaml')],
  INFO: [collector('collector.yaml')],
  DEBUG: [collector('collector.yaml')],
  ALL: [collector('collector.yaml')],
};
