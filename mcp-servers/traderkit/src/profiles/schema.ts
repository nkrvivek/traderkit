import { z } from "zod";

export const TaxEntity = z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, "lowercase-kebab tax entity");
export type TaxEntity = z.infer<typeof TaxEntity>;

export const Broker = z.enum(["snaptrade", "tradestation", "ibkr-direct"]);
export type Broker = z.infer<typeof Broker>;

export const LegShape = z.enum(["naked_put", "naked_call", "naked_straddle", "naked_strangle"]);

export const RulesToggles = z.object({
  strict_mode: z.boolean().default(true),
  R0_no_stale_data: z.boolean().default(true),
  R1_expiry_day_window: z.boolean().default(true),
  R2_strike_grid: z.boolean().default(true),
  R7_thesis_required: z.boolean().default(true),
  R17_thesis_structure_match: z.boolean().default(true),
  quote_ttl_sec: z.number().positive().default(60),
  regime_ttl_sec: z.number().positive().default(900),
  portfolio_total_ttl_sec: z.number().positive().default(14400),
  activities_ttl_sec: z.number().positive().default(86400),
  expiry_day_window_start_utc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 24h UTC").default("13:30"),
  expiry_day_window_end_utc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 24h UTC").default("14:30"),
});
export type RulesToggles = z.infer<typeof RulesToggles>;

export const DEFAULT_RULES: RulesToggles = {
  strict_mode: true,
  R0_no_stale_data: true,
  R1_expiry_day_window: true,
  R2_strike_grid: true,
  R7_thesis_required: true,
  R17_thesis_structure_match: true,
  quote_ttl_sec: 60,
  regime_ttl_sec: 900,
  portfolio_total_ttl_sec: 14400,
  activities_ttl_sec: 86400,
  expiry_day_window_start_utc: "13:30",
  expiry_day_window_end_utc: "14:30",
};

export const PERMISSIVE_RULES: RulesToggles = {
  ...DEFAULT_RULES,
  strict_mode: false,
  R0_no_stale_data: false,
  R1_expiry_day_window: false,
  R2_strike_grid: false,
  R7_thesis_required: false,
  R17_thesis_structure_match: false,
};

export const ProfileSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, "lowercase-kebab"),
  broker: Broker,
  account_id: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "account_id must be a valid UUID"
  ),
  tax_entity: TaxEntity,
  caps: z.object({
    max_order_notional: z.number().nonnegative(),
    max_single_name_pct: z.number().min(0).max(100),
    forbidden_tools: z.array(z.string()).default([]),
    forbidden_leg_shapes: z.array(LegShape).default([]),
  }),
  rules: RulesToggles.optional(),
  vault_link: z.string().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
