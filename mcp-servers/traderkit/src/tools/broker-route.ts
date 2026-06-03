import { z } from "zod";

const BrokerRoute = z.enum(["SNAPTRADE", "TRADESTATION", "MANUAL", "DEFERRED"]);
type BrokerRoute = z.infer<typeof BrokerRoute>;

const SNAPTRADE_BROKERS = new Set(["fidelity", "e-trade", "etrade", "robinhood", "schwab", "ibkr"]);
const TRADESTATION_BROKERS = new Set(["tradestation", "ts"]);
const MANUAL_BROKERS = new Set(["ally", "morgan-stanley", "vanguard"]);

export const BrokerRouteArgs = z.object({
  broker: z.string().min(1),
  direction: z.string().min(1),
  structure: z.string().optional(),
  deferred_tags: z.array(z.string()).default([]),
});

function classifyBrokerRoute(
  broker: string,
  direction: string,
  structure: string | undefined,
  deferredTags: readonly string[],
): { route: BrokerRoute; detail: string } {
  const brokerLower = broker.toLowerCase();

  if (deferredTags.length > 0) {
    return { route: "DEFERRED", detail: `deferred: ${deferredTags.join(", ")}` };
  }

  if (MANUAL_BROKERS.has(brokerLower)) {
    return { route: "MANUAL", detail: `${broker} requires manual execution` };
  }

  if (TRADESTATION_BROKERS.has(brokerLower)) {
    return { route: "TRADESTATION", detail: `route via traderkit native ts_* tools` };
  }

  if (SNAPTRADE_BROKERS.has(brokerLower)) {
    return { route: "SNAPTRADE", detail: `route via SnapTrade MCP` };
  }

  return { route: "MANUAL", detail: `unknown broker ${broker} — fallback to manual` };
}

export async function brokerRouteHandler(raw: unknown) {
  const args = BrokerRouteArgs.parse(raw);
  const result = classifyBrokerRoute(args.broker, args.direction, args.structure, args.deferred_tags);
  return { broker: args.broker, direction: args.direction, ...result };
}
