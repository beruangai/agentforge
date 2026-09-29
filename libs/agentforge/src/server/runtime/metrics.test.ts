import { describe, expect, it, vi } from 'vitest';
import { createOperationalMetrics } from './metrics.ts';

describe('createOperationalMetrics', () => {
  it('publishes a count under the runtime the construct names', async () => {
    const send = vi.fn().mockResolvedValue({});
    const metrics = createOperationalMetrics(
      { AGENTFORGE_METRICS_RUNTIME_NAME: 'agent_runtime' },
      () => ({ send }),
    );
    metrics.count('TasksLost', 'task-1');
    await metrics.flush();
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Namespace: 'AgentForge',
      MetricData: [
        {
          MetricName: 'TasksLost',
          Dimensions: [{ Name: 'AgentRuntimeName', Value: 'agent_runtime' }],
          Unit: 'Count',
          Value: 1,
        },
      ],
    });
  });

  it('only logs where no runtime is named, as locally', async () => {
    const makeClient = vi.fn();
    const metrics = createOperationalMetrics({}, makeClient);
    metrics.count('TasksLost', 'task-1');
    await metrics.flush();
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('logs a count it could not publish as an error, and still settles', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const metrics = createOperationalMetrics(
      { AGENTFORGE_METRICS_RUNTIME_NAME: 'agent_runtime' },
      () => ({ send: vi.fn().mockRejectedValueOnce(new Error('denied')) }),
    );
    metrics.count('OutcomesUnrecorded', 'task-1');
    await metrics.flush();
    expect(error).toHaveBeenCalledWith(
      'the OutcomesUnrecorded count for task task-1 could not be published',
      expect.any(Error),
    );
    error.mockRestore();
  });
});
