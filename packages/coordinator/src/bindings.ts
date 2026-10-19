import { z } from 'zod';
export const bindingSchema = z.object({ taskRef: z.string().min(1), owner: z.string().min(1), repositoryId: z.string().min(1), worktreePath: z.string().min(1), expectedVersion: z.number().int().positive() }).strict();
