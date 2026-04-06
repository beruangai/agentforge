import { describe, expect, it } from 'vitest';
import { retryPresets } from './presets.js';
import { NON_RETRYABLE_ERROR_TYPES } from '../activity/error-classification.js';

describe('retryPresets', () => {
  describe('longRunning', () => {
    it('has 15 minute timeout', () => {
      expect(retryPresets.longRunning.startToCloseTimeout).toBe('15 minutes');
    });

    it('has 30 second heartbeat timeout', () => {
      expect(retryPresets.longRunning.heartbeatTimeout).toBe('30 seconds');
    });

    it('allows 3 retry attempts', () => {
      expect(retryPresets.longRunning.retry.maximumAttempts).toBe(3);
    });

    it('includes non-retryable error types', () => {
      expect(retryPresets.longRunning.retry.nonRetryableErrorTypes).toEqual(
        expect.arrayContaining([...NON_RETRYABLE_ERROR_TYPES]),
      );
    });
  });

  describe('standard', () => {
    it('has 10 minute timeout', () => {
      expect(retryPresets.standard.startToCloseTimeout).toBe('10 minutes');
    });

    it('has 30 second heartbeat timeout', () => {
      expect(retryPresets.standard.heartbeatTimeout).toBe('30 seconds');
    });

    it('allows 2 retry attempts', () => {
      expect(retryPresets.standard.retry.maximumAttempts).toBe(2);
    });
  });

  describe('quick', () => {
    it('has 5 minute timeout', () => {
      expect(retryPresets.quick.startToCloseTimeout).toBe('5 minutes');
    });

    it('has no heartbeat timeout', () => {
      expect(retryPresets.quick.heartbeatTimeout).toBeUndefined();
    });

    it('allows 2 retry attempts', () => {
      expect(retryPresets.quick.retry.maximumAttempts).toBe(2);
    });
  });

  describe('custom', () => {
    it('merges overrides with standard defaults', () => {
      const custom = retryPresets.custom({
        startToCloseTimeout: '20 minutes',
      });

      expect(custom.startToCloseTimeout).toBe('20 minutes');
      // Inherits standard retry config
      expect(custom.retry.maximumAttempts).toBe(2);
      expect(custom.retry.backoffCoefficient).toBe(2);
    });

    it('merges nested retry overrides', () => {
      const custom = retryPresets.custom({
        retry: {
          maximumAttempts: 5,
          initialInterval: '30s',
          backoffCoefficient: 3,
          maximumInterval: '5m',
          nonRetryableErrorTypes: ['CustomError'],
        },
      });

      expect(custom.retry.maximumAttempts).toBe(5);
      expect(custom.retry.initialInterval).toBe('30s');
      expect(custom.retry.nonRetryableErrorTypes).toEqual(['CustomError']);
      // Overridden
      expect(custom.retry.backoffCoefficient).toBe(3);
    });

    it('preserves standard non-retryable types when not overridden', () => {
      const custom = retryPresets.custom({
        startToCloseTimeout: '20 minutes',
      });

      expect(custom.retry.nonRetryableErrorTypes).toEqual(
        expect.arrayContaining([...NON_RETRYABLE_ERROR_TYPES]),
      );
    });
  });

  describe('type compatibility with proxyActivities', () => {
    it('all presets have required fields for Temporal', () => {
      for (const preset of [
        retryPresets.longRunning,
        retryPresets.standard,
        retryPresets.quick,
      ]) {
        expect(preset).toHaveProperty('startToCloseTimeout');
        expect(preset).toHaveProperty('retry');
        expect(preset.retry).toHaveProperty('maximumAttempts');
        expect(preset.retry).toHaveProperty('nonRetryableErrorTypes');
      }
    });
  });
});
