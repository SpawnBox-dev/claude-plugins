import { readFileSync } from "node:fs";
import { z } from "zod";
const id = z.string().regex(/^\d{15,22}$/);
export const configSchema = z
  .object({
    destinations: z
      .object({
        bugForumId: id,
        featureForumId: id,
        supportCategoryId: id,
        helperApplicationsForumId: id,
      })
      .strict()
      .optional(),
    schemaVersion: z.literal(1),
    projectRoot: z.string().min(1),
    botApplicationId: id,
    guildId: id,
    ownerIds: z.array(id).min(1),
    dmAllowUsers: z.array(id),
    channels: z.record(
      id,
      z
        .object({
          audience: z.enum(["public", "helpers", "staff", "private"]),
          requireMention: z.boolean(),
          allowUsers: z.array(id),
        })
        .strict(),
    ),
    diagnosticWebhooks: z.record(id, z.array(id)).default({}),
    model: z.string().min(1),
    codexExecutable: z.string().min(1),
    codexHome: z.string().min(1),
    orchestratorRoot: z.string().min(1),
    maxConcurrency: z.number().int().min(1).max(8).default(2),
    memoryEmbeddings: z.boolean().default(true),
    projectKnowledge: z.boolean().default(false),
    catchupPageLimit: z.number().int().min(1).max(1000).default(50),
  })
  .strict();
export function loadConfig(path: string) {
  return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
