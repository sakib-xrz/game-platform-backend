import { z } from 'zod';
import { TEEN_PATTI_MIN_RESULT_DURATION_MS } from '@/modules/teen-patti/teen-patti.constant';
import { LUCKY_77_SLOT_MAP } from '@/modules/lucky-77/lucky-77.constant';

/** The physical wheel is fixed, so admin configs may only tune these codes. */
const LUCKY_77_ALLOWED_OPTION_CODES = [...new Set(LUCKY_77_SLOT_MAP)] as string[];

const positiveIntegerString = z.string().regex(/^[1-9]\d*$/);

const emptyToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? null : value), schema);

/** Absolute CDN URLs and legacy static paths such as `/assets/greedy/hot-dog.png`. */
const optionImageUrlSchema = z.union([
  z.string().trim().url(),
  z.string().trim().regex(/^\/[^\s]+$/),
]).optional().nullable();

const optionAssetIdSchema = emptyToNull(z.string().trim().cuid().nullable().optional());

const optionalNotesSchema = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.string().trim().max(500).optional(),
);

export const isLegacyOptionImageUrl = (value: string) => value.startsWith('/');

const chipValueSchema = z.object({
  amount: positiveIntegerString,
  display_order: z.number().int().min(1).max(100),
  is_enabled: z.boolean().default(true),
});

const optionSchema = z.object({
  code: z.string().trim().min(2).max(50).regex(/^[A-Z0-9_]+$/),
  name: z.string().trim().min(1).max(100),
  image_url: optionImageUrlSchema,
  asset_id: optionAssetIdSchema,
  display_order: z.number().int().min(1).max(100),
  payout_numerator: positiveIntegerString,
  payout_denominator: positiveIntegerString.default('1'),
  probability_weight: positiveIntegerString,
  is_enabled: z.boolean().default(true),
});

export const createGreedyConfigSchema = z.object({
  body: z
    .object({
      betting_duration_ms: z.number().int().min(3000).max(120000),
      lock_duration_ms: z.number().int().min(250).max(10000),
      drawing_duration_ms: z.number().int().min(1000).max(30000),
      result_duration_ms: z.number().int().min(1000).max(30000),
      min_bet: positiveIntegerString,
      max_single_bet: positiveIntegerString,
      max_round_bet: positiveIntegerString,
      notes: optionalNotesSchema,
      chip_values: z.array(chipValueSchema).min(1).max(12),
      options: z.array(optionSchema).length(8),
    })
    .superRefine((value, ctx) => {
      const min_bet = BigInt(value.min_bet);
      const max_single_bet = BigInt(value.max_single_bet);
      const max_round_bet = BigInt(value.max_round_bet);
      if (min_bet > max_single_bet) {
        ctx.addIssue({ code: 'custom', path: ['max_single_bet'], message: 'max_single_bet must be >= min_bet' });
      }
      if (max_single_bet > max_round_bet) {
        ctx.addIssue({ code: 'custom', path: ['max_round_bet'], message: 'max_round_bet must be >= max_single_bet' });
      }
      const chip_amounts = new Set(value.chip_values.map((item) => item.amount));
      const chip_orders = new Set(value.chip_values.map((item) => item.display_order));
      if (chip_amounts.size !== value.chip_values.length) {
        ctx.addIssue({ code: 'custom', path: ['chip_values'], message: 'Chip amounts must be unique' });
      }
      if (chip_orders.size !== value.chip_values.length) {
        ctx.addIssue({ code: 'custom', path: ['chip_values'], message: 'Chip display_order values must be unique' });
      }

      const codes = new Set(value.options.map((item) => item.code));
      const orders = new Set(value.options.map((item) => item.display_order));
      if (codes.size !== value.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option codes must be unique' });
      }
      if (orders.size !== value.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option display_order values must be unique' });
      }

      const enabled = value.options.filter((item) => item.is_enabled);
      const total_weight = enabled.reduce(
        (sum, item) => sum + BigInt(item.probability_weight),
        0n,
      );
      if (total_weight <= 0n) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Enabled options must have positive total probability weight' });
      } else {
        for (const option of enabled) {
          const weight = BigInt(option.probability_weight);
          const numerator = BigInt(option.payout_numerator);
          const denominator = BigInt(option.payout_denominator);
          if (weight * numerator > total_weight * denominator) {
            ctx.addIssue({
              code: 'custom',
              path: ['options'],
              message: `${option.code} has an expected payout above 100% and is blocked by the safety validator`,
            });
          }
        }
      }
    }),
});

export const configParamSchema = z.object({
  params: z.object({ config_id: z.string().trim().cuid() }),
});

export const cancelRoundSchema = z.object({
  body: z.object({ reason: z.string().trim().min(3).max(250), approval_id: z.string().trim().cuid().optional() }),
});

export const approvalParamSchema = z.object({
  body: z.object({ approval_id: z.string().trim().cuid() }),
});

export type CreateGreedyConfigBody = z.infer<typeof createGreedyConfigSchema>['body'];

/** Same 8-option validation as Greedy; used by Greedy Classic admin routes. */
export const createGreedyClassicConfigSchema = createGreedyConfigSchema;
export type CreateGreedyClassicConfigBody = CreateGreedyConfigBody;
export type CancelRoundBody = z.infer<typeof cancelRoundSchema>['body'];

export const createLucky77ConfigSchema = z.object({
  body: z
    .object({
      betting_duration_ms: z.number().int().min(3000).max(120000),
      lock_duration_ms: z.number().int().min(250).max(10000),
      drawing_duration_ms: z.number().int().min(1000).max(30000),
      result_duration_ms: z.number().int().min(1000).max(30000),
      min_bet: positiveIntegerString,
      max_single_bet: positiveIntegerString,
      max_round_bet: positiveIntegerString,
      notes: optionalNotesSchema,
      chip_values: z.array(chipValueSchema).min(1).max(12),
      options: z.array(optionSchema).length(3),
    })
    .superRefine((value, ctx) => {
      const min_bet = BigInt(value.min_bet);
      const max_single_bet = BigInt(value.max_single_bet);
      const max_round_bet = BigInt(value.max_round_bet);
      if (min_bet > max_single_bet) {
        ctx.addIssue({ code: 'custom', path: ['max_single_bet'], message: 'max_single_bet must be >= min_bet' });
      }
      if (max_single_bet > max_round_bet) {
        ctx.addIssue({ code: 'custom', path: ['max_round_bet'], message: 'max_round_bet must be >= max_single_bet' });
      }
      const chip_amounts = new Set(value.chip_values.map((item) => item.amount));
      const chip_orders = new Set(value.chip_values.map((item) => item.display_order));
      if (chip_amounts.size !== value.chip_values.length) {
        ctx.addIssue({ code: 'custom', path: ['chip_values'], message: 'Chip amounts must be unique' });
      }
      if (chip_orders.size !== value.chip_values.length) {
        ctx.addIssue({ code: 'custom', path: ['chip_values'], message: 'Chip display_order values must be unique' });
      }

      const codes = new Set(value.options.map((item) => item.code));
      const orders = new Set(value.options.map((item) => item.display_order));
      if (codes.size !== value.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option codes must be unique' });
      }
      if (orders.size !== value.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option display_order values must be unique' });
      }

      const allowed_codes = new Set(LUCKY_77_ALLOWED_OPTION_CODES);
      const provided_codes = new Set(value.options.map((item) => item.code));
      const codes_match =
        provided_codes.size === allowed_codes.size &&
        [...provided_codes].every((code) => allowed_codes.has(code));
      if (!codes_match) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: `Lucky 77 options must be exactly ${LUCKY_77_ALLOWED_OPTION_CODES.join(', ')}` });
      }

      const enabled = value.options.filter((item) => item.is_enabled);
      if (enabled.length !== 3) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Lucky 77 requires exactly three enabled options' });
      }
      const total_weight = enabled.reduce(
        (sum, item) => sum + BigInt(item.probability_weight),
        0n,
      );
      if (total_weight <= 0n) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Enabled options must have positive total probability weight' });
      } else {
        for (const option of enabled) {
          const weight = BigInt(option.probability_weight);
          const numerator = BigInt(option.payout_numerator);
          const denominator = BigInt(option.payout_denominator);
          if (weight * numerator > total_weight * denominator) {
            ctx.addIssue({
              code: 'custom',
              path: ['options'],
              message: `${option.code} has an expected payout above 100% and is blocked by the safety validator`,
            });
          }
        }
      }
    }),
});

export type CreateLucky77ConfigBody = z.infer<typeof createLucky77ConfigSchema>['body'];

const teenPattiOptionSchema = z.object({
  code: z.string().trim().min(2).max(50).regex(/^[A-Z0-9_]+$/),
  name: z.string().trim().min(1).max(100),
  image_url: optionImageUrlSchema,
  asset_id: optionAssetIdSchema,
  display_order: z.number().int().min(1).max(100),
  is_enabled: z.boolean().default(true),
});

export const createTeenPattiConfigSchema = z.object({
  body: z
    .object({
      betting_duration_ms: z.number().int().min(3000).max(120000),
      lock_duration_ms: z.number().int().min(250).max(10000),
      drawing_duration_ms: z.number().int().min(1000).max(30000),
      // The player experience reserves ~3s for reveal/winner/payout motion and
      // at least 1.6s for the readable result sheet. Keep a small scheduling
      // margin so a valid config cannot close the round mid-animation.
      result_duration_ms: z.number().int().min(TEEN_PATTI_MIN_RESULT_DURATION_MS).max(30000),
      min_bet: positiveIntegerString,
      max_single_bet: positiveIntegerString,
      max_round_bet: positiveIntegerString,
      rake_bps: z.number().int().min(0).max(2000),
      notes: optionalNotesSchema,
      chip_values: z.array(chipValueSchema).min(1).max(12),
      options: z.array(teenPattiOptionSchema).length(3),
    })
    .superRefine((value, ctx) => {
      const min_bet = BigInt(value.min_bet);
      const max_single_bet = BigInt(value.max_single_bet);
      const max_round_bet = BigInt(value.max_round_bet);
      if (min_bet > max_single_bet) {
        ctx.addIssue({ code: 'custom', path: ['max_single_bet'], message: 'max_single_bet must be >= min_bet' });
      }
      if (max_single_bet > max_round_bet) {
        ctx.addIssue({ code: 'custom', path: ['max_round_bet'], message: 'max_round_bet must be >= max_single_bet' });
      }
      const chip_amounts = new Set(value.chip_values.map((item) => item.amount));
      const chip_orders = new Set(value.chip_values.map((item) => item.display_order));
      if (chip_amounts.size !== value.chip_values.length) {
        ctx.addIssue({ code: 'custom', path: ['chip_values'], message: 'Chip amounts must be unique' });
      }
      if (chip_orders.size !== value.chip_values.length) {
        ctx.addIssue({ code: 'custom', path: ['chip_values'], message: 'Chip display_order values must be unique' });
      }
      value.chip_values.forEach((chip, index) => {
        const amount = BigInt(chip.amount);
        if (chip.is_enabled && (amount < min_bet || amount > max_single_bet)) {
          ctx.addIssue({
            code: 'custom',
            path: ['chip_values', index, 'amount'],
            message: 'Enabled chip amount must be between min_bet and max_single_bet',
          });
        }
      });

      const codes = new Set(value.options.map((item) => item.code));
      const orders = new Set(value.options.map((item) => item.display_order));
      if (codes.size !== value.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Deck codes must be unique' });
      }
      if (orders.size !== value.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Deck display_order values must be unique' });
      }

      const enabled = value.options.filter((item) => item.is_enabled);
      if (enabled.length !== 3) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Teen Patti requires exactly three enabled decks' });
      }
    }),
});

export type CreateTeenPattiConfigBody = z.infer<typeof createTeenPattiConfigSchema>['body'];
