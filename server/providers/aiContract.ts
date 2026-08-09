import { z } from "zod";

export const AI_PROVIDER_IDS = ["codex-sdk", "opencode-agent-reach"] as const;
export type ResearchProviderId = (typeof AI_PROVIDER_IDS)[number];

export const researchSourceSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    url: z
      .string()
      .trim()
      .max(2_048)
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      }, "Only absolute HTTP(S) source URLs are accepted"),
  })
  .strict();

export const researchModelOutputSchema = z
  .object({
    summary: z.string().trim().min(1).max(20_000),
    changeSummary: z.string().trim().min(1).max(4_000),
    changed: z.boolean(),
    sources: z.array(researchSourceSchema).min(1).max(10),
    suggestedStatus: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const searchEvidenceSchema = z
  .object({
    mode: z.literal("live"),
    query: z.string().trim().min(1).max(2_000),
    searchedAt: z.string().datetime({ offset: true }),
    observedUrls: z.array(researchSourceSchema.shape.url).min(1).max(50),
  })
  .strict();

export const researchResultSchema = researchModelOutputSchema
  .extend({
    provider: z.enum(AI_PROVIDER_IDS),
    searchEvidence: searchEvidenceSchema,
  })
  .strict();

export type ResearchModelOutput = z.infer<typeof researchModelOutputSchema>;
export type ResearchResult = z.infer<typeof researchResultSchema>;

export const researchJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "changeSummary", "changed", "sources"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 20_000 },
    changeSummary: { type: "string", minLength: 1, maxLength: 4_000 },
    changed: { type: "boolean" },
    sources: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 300 },
          url: { type: "string", minLength: 1, maxLength: 2_048, format: "uri" },
        },
      },
    },
    suggestedStatus: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

export function parseResearchModelOutput(value: unknown): ResearchModelOutput {
  const parsed = researchModelOutputSchema.parse(value);
  const seen = new Set<string>();
  const sources = parsed.sources.filter((source) => {
    const normalized = source.url.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  if (sources.length === 0) throw new Error("Research completed without a valid source URL");
  return { ...parsed, sources };
}

export function extractHttpUrls(value: unknown): string[] {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const matches = serialized.match(/https?:\/\/[^\s"'<>\\\]}),]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.;:!?]+$/, "")))].slice(0, 50);
}
