import { z } from "zod";

/**
 * Node fields shared by the GraphQL list schemas (issues.ts, pulls.ts):
 * every queried issue/PR node carries the same four identity fields, so
 * the node objects spread these instead of re-declaring them.
 */
export const graphqlNodeSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  updatedAt: z.string(),
});
