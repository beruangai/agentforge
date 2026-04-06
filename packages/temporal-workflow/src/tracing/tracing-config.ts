import type { TracingConfig, TracingResult } from './types.js';

/**
 * Configure OpenTelemetry tracing for a Temporal worker.
 * Returns worker sinks/interceptors and a shutdown function.
 *
 * Requires optional peer dependencies:
 * - @temporalio/interceptors-opentelemetry
 * - @opentelemetry/sdk-trace-node
 * - @opentelemetry/exporter-trace-otlp-http
 */
export async function createTracingConfig(
  config: TracingConfig,
): Promise<TracingResult> {
  const { otlp, serviceName } = config;

  // Dynamic imports — these are optional peer dependencies
  const [
    { OTLPTraceExporter },
    { NodeTracerProvider, BatchSpanProcessor },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME },
    otelInterceptors,
  ] = await Promise.all([
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
    import('@temporalio/interceptors-opentelemetry'),
  ]);

  const { OpenTelemetryActivityInboundInterceptor, makeWorkflowExporter } =
    otelInterceptors;

  // Create OTLP exporter
  const exporter = new OTLPTraceExporter({
    url: otlp.endpoint,
    headers: otlp.headers,
  });

  // Create trace provider
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
  const provider = new NodeTracerProvider({ resource });

  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  // Build worker config
  const workerConfig = {
    sinks: {
      exporter: makeWorkflowExporter(exporter, resource),
    },
    interceptors: {
      activityInbound: [
        // Temporal SDK types the context parameter internally
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ctx: any) => new OpenTelemetryActivityInboundInterceptor(ctx),
      ],
    },
  };

  const shutdown = async () => {
    await provider.shutdown();
  };

  return { workerConfig, shutdown };
}
