import { Decimal } from "decimal.js";
import { z } from "zod";

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const decimalString = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(decimalPattern, "Expected a base-10 decimal string")
  .refine((value) => new Decimal(value).isFinite(), "Decimal must be finite");

export const nonNegativeDecimalString = decimalString.refine(
  (value) => new Decimal(value).gte(0),
  "Decimal must be greater than or equal to zero",
);

export const entityId = z.string().trim().regex(entityIdPattern, "Invalid entity id");
export const isoDateTime = z.string().datetime({ offset: true });
export const currency = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/);
export const safeUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (value === "") return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Only absolute HTTP(S) URLs are accepted");

export const assetKindSchema = z.enum(["crypto", "stock", "fund", "wealth", "cash", "other"]);
export const priceModeSchema = z.enum(["manual", "provider"]);
export const operationTypeSchema = z.enum([
  "opening",
  "buy",
  "sell",
  "transfer_in",
  "transfer_out",
  "dividend",
  "interest",
  "fee",
  "adjustment",
  "claim",
]);
export const expectedStageSchema = z.enum([
  "discovered",
  "watching",
  "eligible",
  "claimable",
  "claimed",
  "missed",
  "expired",
  "rejected",
]);
export const expectedHealthSchema = z.enum(["healthy", "due", "failed", "risk"]);
export const confidenceSchema = z.enum(["low", "medium", "high"]);
export const eventStatusSchema = z.enum(["active", "paused", "expired"]);

export const assetCreateSchema = z
  .object({
    id: entityId.optional(),
    name: z.string().trim().min(1).max(160),
    symbol: z.string().trim().min(1).max(80),
    kind: assetKindSchema,
    account: z.string().trim().max(160).default(""),
    currency,
    quantity: nonNegativeDecimalString.default("0"),
    unitCost: nonNegativeDecimalString.default("0"),
    currentPrice: nonNegativeDecimalString.default("0"),
    priceMode: priceModeSchema.default("manual"),
    priceSource: z.string().trim().min(1).max(80).default("manual"),
    priceUpdatedAt: isoDateTime.optional(),
    staleAfterHours: z.number().int().min(1).max(24 * 365).default(24),
    notes: z.string().max(10_000).default(""),
  })
  .strict();

export const assetPatchSchema = assetCreateSchema
  .omit({ id: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const priceUpdateSchema = z
  .object({
    price: nonNegativeDecimalString.optional(),
    currency: currency.optional(),
    source: z.string().trim().min(1).max(80).optional(),
    asOf: isoDateTime.optional(),
  })
  .strict();

export const operationCreateSchema = z
  .object({
    id: entityId.optional(),
    type: operationTypeSchema,
    quantity: nonNegativeDecimalString.optional(),
    quantityDelta: decimalString.optional(),
    unitPrice: nonNegativeDecimalString.default("0"),
    fee: nonNegativeDecimalString.default("0"),
    currency: currency.optional(),
    note: z.string().max(10_000).default(""),
    occurredAt: isoDateTime.optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (value) => value.quantity === undefined || value.quantityDelta === undefined,
    "Use quantity or quantityDelta, not both",
  );

export const expectedCreateSchema = z
  .object({
    id: entityId.optional(),
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().max(100).default(""),
    ecosystem: z.string().trim().max(100).default(""),
    stage: expectedStageSchema.default("discovered"),
    health: expectedHealthSchema.default("healthy"),
    nextAction: z.string().trim().max(2_000).default(""),
    deadline: isoDateTime.nullable().default(null),
    estimatedLow: nonNegativeDecimalString.default("0"),
    estimatedHigh: nonNegativeDecimalString.default("0"),
    currency,
    investedCost: nonNegativeDecimalString.default("0"),
    confidence: confidenceSchema.default("low"),
    sourceUrl: safeUrl.default(""),
    keywords: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    latestUpdate: z.string().max(20_000).default(""),
    lastCheckedAt: isoDateTime.optional(),
    nextCheckAt: isoDateTime.optional(),
    notes: z.string().max(20_000).default(""),
  })
  .strict()
  .refine(
    (value) => new Decimal(value.estimatedHigh).gte(value.estimatedLow),
    { message: "estimatedHigh must be greater than or equal to estimatedLow", path: ["estimatedHigh"] },
  );

export const expectedPatchSchema = z
  .object(expectedCreateSchema.shape)
  .omit({ id: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .refine(
    (value) =>
      value.estimatedLow === undefined ||
      value.estimatedHigh === undefined ||
      new Decimal(value.estimatedHigh).gte(value.estimatedLow),
    { message: "estimatedHigh must be greater than or equal to estimatedLow", path: ["estimatedHigh"] },
  );

export const expectedConvertSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    symbol: z.string().trim().min(1).max(80),
    kind: assetKindSchema.default("crypto"),
    account: z.string().trim().max(160).default(""),
    currency: currency.optional(),
    quantity: nonNegativeDecimalString.refine((value) => new Decimal(value).gt(0), "Quantity must be greater than zero"),
    unitCost: nonNegativeDecimalString.default("0"),
    currentPrice: nonNegativeDecimalString.default("0"),
    priceMode: priceModeSchema.default("manual"),
    priceSource: z.string().trim().min(1).max(80).default("manual"),
    notes: z.string().max(10_000).default(""),
  })
  .strict();

export const eventCreateSchema = z
  .object({
    id: entityId.optional(),
    name: z.string().trim().min(1).max(200),
    topic: z.string().trim().min(1).max(2_000),
    instructions: z.string().trim().min(1).max(20_000),
    schedule: z.string().trim().min(1).max(120),
    scheduleLabel: z.string().trim().max(200).default(""),
    timezone: z.string().trim().min(1).max(100).default("Asia/Shanghai"),
    nextRunAt: isoDateTime.nullable().optional(),
    status: eventStatusSchema.default("active"),
    notifyOnChangeOnly: z.boolean().default(true),
    emailEnabled: z.boolean().default(false),
    emailTo: z.string().trim().email().or(z.literal("")).default(""),
  })
  .strict()
  .refine((value) => !value.emailEnabled || value.emailTo.length > 0, {
    message: "emailTo is required when emailEnabled is true",
    path: ["emailTo"],
  });

export const eventPatchSchema = z
  .object(eventCreateSchema.shape)
  .omit({ id: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const settingsPatchSchema = z
  .object({
    baseCurrency: currency.optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    locale: z.string().trim().min(1).max(40).optional(),
    proxyUrl: safeUrl.optional(),
    aiProvider: z.string().trim().min(1).max(80).optional(),
    aiBaseUrl: safeUrl.optional(),
    aiModel: z.string().trim().max(160).optional(),
    aiConfigured: z.boolean().optional(),
    smtpHost: z.string().trim().max(255).optional(),
    smtpPort: z.number().int().min(1).max(65_535).optional(),
    smtpSecure: z.boolean().optional(),
    smtpFrom: z.string().trim().max(320).optional(),
    notificationEmail: z.string().trim().email().or(z.literal("")).optional(),
    smtpConfigured: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export type AssetCreateInput = z.infer<typeof assetCreateSchema>;
export type AssetPatchInput = z.infer<typeof assetPatchSchema>;
export type OperationCreateInput = z.infer<typeof operationCreateSchema>;
export type PriceUpdateInput = z.infer<typeof priceUpdateSchema>;
export type ExpectedCreateInput = z.infer<typeof expectedCreateSchema>;
export type ExpectedPatchInput = z.infer<typeof expectedPatchSchema>;
export type EventCreateInput = z.infer<typeof eventCreateSchema>;
export type EventPatchInput = z.infer<typeof eventPatchSchema>;
