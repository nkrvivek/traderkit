import { type Profile, DEFAULT_RULES } from "../profiles/schema.js";
import type { Activity } from "../mcp/snaptrade-read-client.js";
import { checkCaps, type TradeProposal, type GateResult } from "./caps.js";
import { checkWashSale } from "./wash-sale.js";
import { checkExpiryDayWindow } from "./expiry-day-window.js";
import { checkStrikeGrid, type StrikeGridEntry } from "./strike-grid.js";
import { checkThesisRequired, type ActiveThesis } from "./thesis-required.js";
import { checkThesisStructure } from "./thesis-structure.js";
import { checkFreshness } from "./freshness.js";
import { THIRTY_DAYS_MS } from "../utils/date.js";
import { toMessage } from "../utils/errors.js";
import { writeAuditSafe } from "../utils/audit.js";

export interface ComposeInput {
  profile: Profile;
  allProfiles: Profile[];
  trade: TradeProposal;
  fetchActivities: (accountIds: string[], since: Date) => Promise<Activity[]>;
  requireWashSaleCheck?: boolean | undefined;
  now?: Date | undefined;

  // R0 freshness stamps
  quote_as_of?: string | undefined;
  grid_as_of?: string | undefined;
  regime_as_of?: string | undefined;
  portfolio_total_as_of?: string | undefined;
  activities_as_of?: string | undefined;

  expiry_date?: string | undefined;
  strike_grid?: StrikeGridEntry[] | undefined;
  is_wheel_assignment_leg?: boolean | undefined;
  thesis_ref?: string | undefined;
  discretionary_event?: boolean | undefined;
  discretionary_rationale?: string | undefined;
  active_theses?: ActiveThesis[] | undefined;
  proposed_structure?: string | undefined;
  thesis_md_path?: string | undefined;
  thesis_md_sha256?: string | undefined;
}

export interface ComposeResult extends GateResult {
  ticket_id?: string;
}

function isShortOpen(trade: TradeProposal): boolean {
  return trade.direction === "SELL_TO_OPEN" || (trade.leg_shape ?? "").startsWith("naked_");
}

export async function composeCheckTrade(input: ComposeInput): Promise<ComposeResult> {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const warnings: string[] = [];
  const rules = input.profile.rules ?? DEFAULT_RULES;
  const strict = rules.strict_mode;

  const requireQuote = isShortOpen(input.trade);
  const requireGrid = isShortOpen(input.trade) && rules.R2_strike_grid && !input.is_wheel_assignment_leg;
  const requirePortfolio = input.trade.portfolio_total_usd > 0;

  const r0 = checkFreshness({
    profile: input.profile,
    now,
    quote_as_of: input.quote_as_of,
    grid_as_of: input.grid_as_of,
    regime_as_of: input.regime_as_of,
    portfolio_total_as_of: input.portfolio_total_as_of,
    activities_as_of: input.activities_as_of,
    require_quote: requireQuote,
    require_grid: requireGrid,
    require_portfolio_total: requirePortfolio,
    require_activities: true,
  });
  reasons.push(...r0.reasons);
  warnings.push(...r0.warnings);

  const caps = checkCaps(input.profile, input.trade);
  reasons.push(...caps.reasons);
  warnings.push(...caps.warnings);

  if (strict && input.trade.portfolio_total_usd === 0) {
    reasons.push("caps: portfolio_total_usd required in strict_mode (cannot verify single-name cap)");
  }

  const r1 = checkExpiryDayWindow({
    profile: input.profile,
    now,
    expiry_date: input.expiry_date,
    direction: input.trade.direction,
    leg_shape: input.trade.leg_shape,
  });
  reasons.push(...r1.reasons);
  warnings.push(...r1.warnings);

  const r2 = checkStrikeGrid({
    profile: input.profile,
    direction: input.trade.direction,
    leg_shape: input.trade.leg_shape,
    selected_strike: input.trade.selected_strike,
    strike_grid: input.strike_grid,
    grid_as_of: input.grid_as_of,
    now,
    is_wheel_assignment_leg: input.is_wheel_assignment_leg,
  });
  reasons.push(...r2.reasons);
  warnings.push(...r2.warnings);

  const r7 = checkThesisRequired({
    profile: input.profile,
    ticker: input.trade.ticker,
    thesis_ref: input.thesis_ref,
    discretionary_event: input.discretionary_event,
    discretionary_rationale: input.discretionary_rationale,
    active_theses: input.active_theses,
  });
  reasons.push(...r7.reasons);
  warnings.push(...r7.warnings);

  const r17 = checkThesisStructure({
    profile: input.profile,
    ticker: input.trade.ticker,
    proposed_structure: input.proposed_structure,
    thesis_md_path: input.thesis_md_path,
    thesis_md_sha256: input.thesis_md_sha256,
    discretionary_event: input.discretionary_event,
  });
  reasons.push(...r17.reasons);
  warnings.push(...r17.warnings);

  const since = new Date(now.getTime() - THIRTY_DAYS_MS);
  const poolAccounts = input.allProfiles
    .filter((p) => p.tax_entity === input.profile.tax_entity)
    .map((p) => p.account_id);

  let activities: Activity[] = [];
  let activitiesOk = true;
  try {
    activities = await input.fetchActivities(poolAccounts, since);
  } catch (e) {
    activitiesOk = false;
    const msg = `wash-sale activities fetch failed: ${toMessage(e)}`;
    // strict_mode default = true → any fetch failure is a reject
    if (strict || input.requireWashSaleCheck) reasons.push(msg);
    else warnings.push(msg);
  }

  if (activitiesOk) {
    const sellAtLoss = input.trade.direction.startsWith("SELL") &&
      input.trade.notional_usd < input.trade.existing_ticker_exposure_usd;
    const ws = checkWashSale({
      action: input.trade.direction.startsWith("BUY") ? "BUY" : "SELL",
      ticker: input.trade.ticker,
      tradeDate: now,
      activeProfile: input.profile,
      allProfiles: input.allProfiles,
      activities,
      sellAtLoss,
    });
    if (ws.flagged) reasons.push(`wash-sale: ${ws.detail}`);
  }

  const passPreAudit = reasons.length === 0;
  const audit = await writeAuditSafe({
    ts: now.toISOString(),
    profile: input.profile.name,
    kind: "check_trade",
    payload: {
      trade: input.trade,
      expiry_date: input.expiry_date,
      thesis_ref: input.thesis_ref,
      stamps: {
        quote_as_of: input.quote_as_of,
        grid_as_of: input.grid_as_of,
        regime_as_of: input.regime_as_of,
        portfolio_total_as_of: input.portfolio_total_as_of,
        activities_as_of: input.activities_as_of,
      },
    },
    pass: passPreAudit,
    reasons,
    warnings,
  });

  if (!audit) {
    const msg = "audit write failed — no durable trail (check TRADERKIT_HOME + disk)";
    if (strict) reasons.push(msg);
    else warnings.push(msg);
  } else if (audit.chain_warning) {
    warnings.push(`audit chain: ${audit.chain_warning}`);
  }

  const pass = reasons.length === 0;
  const result: ComposeResult = { pass, reasons, warnings };
  if (audit) result.ticket_id = audit.ticket_id;
  return result;
}
