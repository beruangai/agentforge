// Runs one case of a kata in its own process, so a solution that throws,
// hangs or exits touches no other case: imports the solution, calls its
// function with the case's arguments and prints the outcome as one JSON line.
// Usage: bun case-runner.ts <solution path> <function name> <arguments JSON>
import { pathToFileURL } from 'node:url';

const [solutionPath, functionName, argumentsJson] = process.argv.slice(2);
if (
  solutionPath === undefined ||
  functionName === undefined ||
  argumentsJson === undefined
) {
  throw new Error(
    'usage: bun case-runner.ts <solution path> <function name> <arguments JSON>',
  );
}

function report(outcome: { returned: string } | { threw: string }): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

try {
  const solution: Record<string, unknown> = await import(
    pathToFileURL(solutionPath).href
  );
  const fn = solution[functionName];
  if (typeof fn !== 'function') {
    throw new Error(`the solution exports no function ${functionName}`);
  }
  const returned: unknown = await fn(...JSON.parse(argumentsJson));
  const json = JSON.stringify(returned);
  if (json === undefined) {
    throw new Error(`returned ${String(returned)}, which is not JSON`);
  }
  report({ returned: json });
} catch (error) {
  report({ threw: error instanceof Error ? error.message : String(error) });
}
