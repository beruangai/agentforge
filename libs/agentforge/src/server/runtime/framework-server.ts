import type { TelemetryLevel } from '#core/telemetry.ts';

/**
 * What the server takes from a project's framework (ADR 0021): the secrets
 * its runs need, and how its task processes export telemetry to the
 * collector. The consumer's server entry passes it; the runtime imports no
 * framework.
 */
export interface FrameworkServer {
  readonly name: string;
  /** The secrets every agent of the framework requires, by the environment variable each becomes. */
  readonly requiredSecrets: readonly string[];
  /** The environment every task process inherits at this level, exporting to the collector at `collectorEndpoint`. */
  telemetryEnvironment(
    level: TelemetryLevel,
    collectorEndpoint: string,
  ): Readonly<Record<string, string>>;
  /** The collector's configuration files at each level, in order. */
  readonly collectorConfig: Readonly<Record<TelemetryLevel, readonly URL[]>>;
}
