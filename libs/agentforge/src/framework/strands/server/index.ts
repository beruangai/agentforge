/**
 * `@beruangai/agentforge/strands/server` — what a `strands` project's server
 * entry passes to `startServer`: the framework's required secrets and its
 * telemetry. Resolvable only under the `agentforge-agent` export condition.
 */
import type { FrameworkServer } from '../../../server/runtime/framework-server.ts';
import { REQUIRED_SECRETS } from '../core/secrets.ts';
import {
  STRANDS_COLLECTOR_CONFIG,
  strandsTelemetryEnvironment,
} from './telemetry.ts';

/** Strands Agents' server part (ADR 0021). */
export const framework: FrameworkServer = {
  name: 'strands',
  requiredSecrets: REQUIRED_SECRETS,
  telemetryEnvironment: strandsTelemetryEnvironment,
  collectorConfig: STRANDS_COLLECTOR_CONFIG,
};
