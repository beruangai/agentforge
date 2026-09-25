import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** A source file a caller sends: a bare name, no directories. */
export const SourceFileSchema = z.object({
  filename: z.string().regex(/^[\w.-]+$/),
  content: z.string(),
});

/** Writes a caller's file into the working directory, returning its path. */
export async function placeSourceFile(
  workingDirectory: string,
  file: z.infer<typeof SourceFileSchema>,
): Promise<string> {
  await mkdir(workingDirectory, { recursive: true });
  const path = join(workingDirectory, file.filename);
  await writeFile(path, file.content);
  return path;
}
