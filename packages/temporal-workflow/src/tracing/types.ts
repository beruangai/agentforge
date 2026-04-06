export interface OtlpConfig {
  /** OTLP endpoint URL (e.g., LangSmith, Langfuse, BrainTrust, Jaeger) */
  endpoint: string;
  /** Auth and routing headers */
  headers: Record<string, string>;
}

export interface TracingConfig {
  /** Standard OTLP exporter config — provider-agnostic */
  otlp: OtlpConfig;
  /** Service name for span attribution */
  serviceName: string;
}

export interface TracingResult {
  /** Spread into Worker.create() options (sinks + interceptors) */
  workerConfig: {
    sinks: Record<string, unknown>;
    interceptors: Record<string, unknown[]>;
  };
  /** Call on shutdown to flush pending spans */
  shutdown(): Promise<void>;
}
