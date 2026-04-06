export class UpstreamNotRunningError extends Error {
  constructor(public readonly upstream: string) {
    super(`Upstream '${upstream}' is not running`);
    this.name = 'UpstreamNotRunningError';
  }
}

export class UnknownUpstreamError extends Error {
  constructor(public readonly upstream: string) {
    super(`Unknown upstream server '${upstream}'`);
    this.name = 'UnknownUpstreamError';
  }
}

export class InvalidToolNameError extends Error {
  constructor(public readonly toolName: string) {
    super(`Invalid tool name '${toolName}': missing server prefix`);
    this.name = 'InvalidToolNameError';
  }
}
