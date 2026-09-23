/**
 * Runs `tsc` over a type-probe file, so that oRPC's types are checked by the
 * `integ` target rather than trusted.
 *
 * oRPC v2 is in beta, and a `@ts-expect-error` probe is exactly what a version
 * bump breaks: a probe that stops erroring is reported as an unused directive
 * (TS2578), so "zero diagnostics" means every probe still fails to compile for
 * the reason it was written.
 *
 * Without a negative control a passing probe proves nothing — the spike's own
 * first control was broken because it pointed at the wrong configuration. So
 * every check compiles, in the same program, a second file that places a
 * directive on a valid line and must be reported as unused. That file is held
 * in memory rather than on disk: on disk it would fail the project's own
 * `typecheck` target, which is the point of it.
 */
import path from 'node:path';
import {
  createFSBackedSystem,
  createVirtualCompilerHost,
} from '@typescript/vfs';
import ts from 'typescript';

/** One diagnostic, reduced to what a test asserts on. */
export interface TypeDiagnostic {
  readonly fileName: string;
  readonly line: number;
  readonly code: number;
  readonly message: string;
}

export interface NegativeControl {
  /** A file name in the probe's directory, so its relative imports resolve. */
  readonly fileName: string;
  readonly sourceText: string;
}

export interface TypecheckResult {
  /** Every diagnostic outside the negative control: the probe and all it imports. */
  readonly probeDiagnostics: readonly TypeDiagnostic[];
  readonly negativeControlDiagnostics: readonly TypeDiagnostic[];
}

/** The unused-`@ts-expect-error` diagnostic a negative control must produce. */
export const UNUSED_TS_EXPECT_ERROR_DIRECTIVE = 2578;

/**
 * The project's own test configuration — the one its `typecheck` target uses —
 * so a probe is judged under the same strictness as everything else.
 */
const packageRoot = path.resolve(import.meta.dirname, '../../../..');
const specConfigurationPath = path.join(packageRoot, 'tsconfig.spec.json');

function readCompilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    specConfigurationPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          `cannot read ${specConfigurationPath}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
        );
      },
    },
  );
  if (parsed === undefined) {
    throw new Error(`cannot read ${specConfigurationPath}`);
  }
  if (parsed.errors.length > 0) {
    throw new Error(
      `${specConfigurationPath} has errors: ${parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, '\n'),
        )
        .join('; ')}`,
    );
  }
  if (parsed.options.strict !== true) {
    throw new Error(
      `${specConfigurationPath} is not strict; type probes are meaningless without it`,
    );
  }
  // A single in-memory check: nothing is emitted and nothing is built.
  return {
    ...parsed.options,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    noEmit: true,
  };
}

function toTypeDiagnostic(diagnostic: ts.Diagnostic): TypeDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return { fileName: '<global>', line: 0, code: diagnostic.code, message };
  }
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return {
    fileName: path.basename(diagnostic.file.fileName),
    line: line + 1,
    code: diagnostic.code,
    message,
  };
}

export function typecheck(
  probeFilePath: string,
  negativeControl: NegativeControl,
): TypecheckResult {
  const options = readCompilerOptions();
  const negativeControlPath = path.join(
    path.dirname(probeFilePath),
    negativeControl.fileName,
  );
  // The negative control is overlaid on the real file system, so the probe,
  // its fixtures and node_modules resolve from disk as they do for `tsc`.
  const system = createFSBackedSystem(
    new Map([[negativeControlPath, negativeControl.sourceText]]),
    packageRoot,
    ts,
  );
  const { compilerHost: host } = createVirtualCompilerHost(system, options, ts);
  const isNegativeControl = (fileName: string) =>
    path.resolve(fileName) === negativeControlPath;

  const program = ts.createProgram({
    rootNames: [probeFilePath, negativeControlPath],
    options,
    host,
  });
  const probeDiagnostics: TypeDiagnostic[] = [];
  const negativeControlDiagnostics: TypeDiagnostic[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const target =
      diagnostic.file !== undefined &&
      isNegativeControl(diagnostic.file.fileName)
        ? negativeControlDiagnostics
        : probeDiagnostics;
    target.push(toTypeDiagnostic(diagnostic));
  }
  return { probeDiagnostics, negativeControlDiagnostics };
}
