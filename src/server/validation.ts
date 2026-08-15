import { z } from "zod";
import { UnsafeIntegrationUrlError, validateIntegrationUrl, validateOutboundUrl } from "./security/outbound.js";

const conflictStrategySchema = z.enum(["latest_wins", "grimmory_wins", "hardcover_wins"]);

const suppliedOutboundUrlSchema = z.string().superRefine((value, context) => {
  try {
    validateOutboundUrl(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof UnsafeIntegrationUrlError ? error.message : "Integration URL must be valid"
    });
  }
});

// Test buttons submit their current form value even when it is blank. Preserve
// the route-level "not configured" response in that case while still rejecting
// any non-blank URL that violates the outbound request policy.
const optionalSuppliedOutboundUrlSchema = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  suppliedOutboundUrlSchema.optional()
);

// Saved integration URLs may be blank to clear a configured value. Non-blank
// values still use the same URL policy as every outbound integration request.
const optionalIntegrationUrlSchema = z.string().superRefine((value, context) => {
  if (!value.trim()) return;
  try {
    validateIntegrationUrl(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof UnsafeIntegrationUrlError ? error.message : "Integration URL must be valid"
    });
  }
}).optional();

const integrationSettingsSchema = z.object({
  baseUrl: z.string().optional(),
  addMenuLink: z.boolean().optional()
}).strict();

export const settingsPatchSchema = z.object({
  general: z.object({ trustProxy: z.boolean().optional() }).strict().optional(),
  grimmory: integrationSettingsSchema.optional(),
  download: integrationSettingsSchema.optional(),
  sync: z.object({
    startupSyncEnabled: z.boolean().optional(),
    historyRetentionDays: z.number().int().positive().optional(),
    conflictStrategy: conflictStrategySchema.optional()
  }).strict().optional(),
  chaptarr: integrationSettingsSchema.extend({ apiKey: z.string().optional() }).optional(),
  audiobookshelf: integrationSettingsSchema.optional()
}).strict();

export const syncRunSchema = z.object({
  profileId: z.number().int().positive().optional(),
  dryRun: z.boolean().optional()
}).strict();

export const integrationTestSchema = z.object({
  baseUrl: optionalSuppliedOutboundUrlSchema
}).strict();

export const chaptarrTestSchema = integrationTestSchema.extend({
  apiKey: z.string().optional()
});

export const profileGrimmoryTestSchema = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  baseUrl: optionalSuppliedOutboundUrlSchema
}).strict();

export const profileHardcoverTestSchema = z.object({ apiToken: z.string().optional() }).strict();
export const profileGoodreadsTestSchema = z.object({ goodreadsUserId: z.string().optional() }).strict();
export const profileAudiobookshelfTestSchema = z.object({ apiKey: z.string().optional() }).strict();

export const jobIntervalSchema = z.object({
  intervalMinutes: z.number().int()
}).strict();

export const writeGrimmoryIdSchema = z.object({
  source: z.enum(["goodreads", "hardcover"])
}).strict();

const syncSettingsSchema = z.object({
  syncStatusEnabled: z.boolean().optional(),
  syncProgressEnabled: z.boolean().optional(),
  syncShelvesEnabled: z.boolean().optional(),
  syncGoodreadsEnabled: z.boolean().optional(),
  syncGoodreadsStatusEnabled: z.boolean().optional(),
  syncGoodreadsShelvesEnabled: z.boolean().optional(),
  syncWriteTagEnabled: z.boolean().optional(),
  conflictStrategy: conflictStrategySchema.optional(),
  scheduleEnabled: z.boolean().optional(),
  scheduleCron: z.string().nullable().optional()
}).strict();

export const profileCreateSchema = z.object({
  displayName: z.string().trim().min(1)
}).strict();

export const profilePatchSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  grimmory: z.object({
    username: z.string().optional(),
    password: z.string().optional(),
    baseUrl: optionalIntegrationUrlSchema
  }).strict().optional(),
  hardcover: z.object({
    enabled: z.boolean().optional(),
    apiToken: z.string().optional(),
    syncListId: z.number().int().positive().nullable().optional(),
    syncListName: z.string().nullable().optional(),
    targetShelfName: z.string().nullable().optional()
  }).strict().optional(),
  goodreads: z.object({
    goodreadsUserId: z.string().optional(),
    enabled: z.boolean().optional(),
    syncShelfName: z.string().nullable().optional(),
    targetShelfName: z.string().nullable().optional()
  }).strict().optional(),
  audiobookshelf: z.object({
    enabled: z.boolean().optional(),
    apiKey: z.string().optional()
  }).strict().optional(),
  syncSettings: syncSettingsSchema.optional()
}).strict();

export const goodreadsMappingsSchema = z.object({
  mappings: z.array(z.object({
    goodreadsShelfName: z.string().trim().min(1),
    grimmoryShelfName: z.string().trim().min(1)
  }).strict())
}).strict();

export const hardcoverMappingsSchema = z.object({
  mappings: z.array(z.object({
    hardcoverListId: z.number().int().positive(),
    hardcoverListName: z.string().trim().min(1),
    grimmoryShelfName: z.string().trim().min(1)
  }).strict())
}).strict();

export type ValidationErrorResponse = {
  error: "Invalid request";
  fieldErrors: Record<string, string[]>;
  formErrors: string[];
};

export function validationErrorResponse(error: z.ZodError): ValidationErrorResponse {
  return {
    error: "Invalid request",
    fieldErrors: z.flattenError(error).fieldErrors,
    formErrors: z.flattenError(error).formErrors
  };
}
