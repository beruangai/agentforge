import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── getTraceEnvVars ──

describe('getTraceEnvVars', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('delegates to langsmith adapter', async () => {
    vi.doMock('./langsmith-adapter.js', () => ({
      getLangSmithTraceEnv: vi.fn().mockResolvedValue({
        LANGSMITH_PARENT_DOTTED_ORDER: 'trace-123',
        LANGSMITH_PARENT_BAGGAGE: 'baggage-456',
      }),
    }));

    const { getTraceEnvVars } = await import('./trace-env.js');
    const result = await getTraceEnvVars();

    expect(result).toEqual({
      LANGSMITH_PARENT_DOTTED_ORDER: 'trace-123',
      LANGSMITH_PARENT_BAGGAGE: 'baggage-456',
    });
  });

  it('returns empty object when adapter returns empty', async () => {
    vi.doMock('./langsmith-adapter.js', () => ({
      getLangSmithTraceEnv: vi.fn().mockResolvedValue({}),
    }));

    const { getTraceEnvVars } = await import('./trace-env.js');
    const result = await getTraceEnvVars();

    expect(result).toEqual({});
  });
});

// ── getLangSmithTraceEnv ──

describe('getLangSmithTraceEnv', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns empty object when langsmith is not available', async () => {
    vi.doMock('langsmith/traceable', () => {
      throw new Error('Module not found');
    });

    const { getLangSmithTraceEnv } =
      await import('./langsmith-adapter.js');
    const result = await getLangSmithTraceEnv();
    expect(result).toEqual({});
  });

  it('returns empty object when getCurrentRunTree throws', async () => {
    vi.doMock('langsmith/traceable', () => ({
      getCurrentRunTree: () => {
        throw new Error('No active run tree');
      },
    }));

    const { getLangSmithTraceEnv } =
      await import('./langsmith-adapter.js');
    const result = await getLangSmithTraceEnv();
    expect(result).toEqual({});
  });
});

// ── createTracingConfig ──

describe('createTracingConfig', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns workerConfig with sinks and interceptors', async () => {
    const mockProvider = {
      addSpanProcessor: vi.fn(),
      register: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock('@opentelemetry/exporter-trace-otlp-http', () => ({
      OTLPTraceExporter: class MockExporter {
        constructor(public config: any) {}
      },
    }));

    vi.doMock('@opentelemetry/sdk-trace-node', () => ({
      NodeTracerProvider: class MockProvider {
        addSpanProcessor = mockProvider.addSpanProcessor;
        register = mockProvider.register;
        shutdown = mockProvider.shutdown;
      },
      BatchSpanProcessor: class MockProcessor {},
    }));

    vi.doMock('@opentelemetry/resources', () => ({
      resourceFromAttributes: vi.fn().mockReturnValue({ attributes: {} }),
    }));

    vi.doMock('@opentelemetry/semantic-conventions', () => ({
      ATTR_SERVICE_NAME: 'service.name',
    }));

    vi.doMock('@temporalio/interceptors-opentelemetry', () => ({
      OpenTelemetryActivityInboundInterceptor: class MockInterceptor {
        constructor(public ctx: any) {}
      },
      makeWorkflowExporter: vi.fn().mockReturnValue({ export: vi.fn() }),
    }));

    const { createTracingConfig } =
      await import('./tracing-config.js');

    const result = await createTracingConfig({
      otlp: {
        endpoint: 'https://example.com/otel/v1/traces',
        headers: { 'x-api-key': 'test-key' },
      },
      serviceName: 'test-worker',
    });

    expect(result.workerConfig).toHaveProperty('sinks');
    expect(result.workerConfig).toHaveProperty('interceptors');
    expect(result.workerConfig.sinks).toHaveProperty('exporter');
    expect(result.workerConfig.interceptors).toHaveProperty('activityInbound');
    expect(result.workerConfig.interceptors.activityInbound).toHaveLength(1);
  });

  it('shutdown flushes the provider', async () => {
    const mockShutdown = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@opentelemetry/exporter-trace-otlp-http', () => ({
      OTLPTraceExporter: class MockExporter {
        constructor(public config: any) {}
      },
    }));

    vi.doMock('@opentelemetry/sdk-trace-node', () => ({
      NodeTracerProvider: class MockProvider {
        addSpanProcessor = vi.fn();
        register = vi.fn();
        shutdown = mockShutdown;
      },
      BatchSpanProcessor: class MockProcessor {},
    }));

    vi.doMock('@opentelemetry/resources', () => ({
      resourceFromAttributes: vi.fn().mockReturnValue({ attributes: {} }),
    }));

    vi.doMock('@opentelemetry/semantic-conventions', () => ({
      ATTR_SERVICE_NAME: 'service.name',
    }));

    vi.doMock('@temporalio/interceptors-opentelemetry', () => ({
      OpenTelemetryActivityInboundInterceptor: class MockInterceptor {
        constructor(public ctx: any) {}
      },
      makeWorkflowExporter: vi.fn().mockReturnValue({}),
    }));

    const { createTracingConfig } =
      await import('./tracing-config.js');

    const result = await createTracingConfig({
      otlp: {
        endpoint: 'https://example.com/otel/v1/traces',
        headers: {},
      },
      serviceName: 'test-worker',
    });

    await result.shutdown();
    expect(mockShutdown).toHaveBeenCalled();
  });
});
