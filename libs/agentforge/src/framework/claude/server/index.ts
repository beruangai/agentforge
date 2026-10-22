/**
 * `@beruangai/agentforge/claude/server` — what a `claude` project's server
 * entry passes to `startServer`: the framework's required secrets and the
 * Claude CLI's telemetry. Resolvable only under the `agentforge-agent` export
 * condition.
 */
import type { FrameworkServer } from '../../../server/runtime/framework-server.ts';
import { REQUIRED_SECRETS } from '../core/secrets.ts';
import {
  CLAUDE_COLLECTOR_CONFIG,
  cliTelemetryEnvironment,
} from './telemetry.ts';

/** The Claude Agent SDK's server part (ADR 0021). */
export const framework: FrameworkServer = {
  name: 'claude',
  requiredSecrets: REQUIRED_SECRETS,
  telemetryEnvironment: cliTelemetryEnvironment,
  collectorConfig: CLAUDE_COLLECTOR_CONFIG,
};
