import { z } from 'zod';

/** A file a caller sends into the workspace: a bare name, no directories. */
export const WorkspaceFileSchema = z.object({
  filename: z.string().regex(/^[\w.-]+$/),
  content: z.string(),
});
