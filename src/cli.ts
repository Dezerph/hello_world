import { join } from "node:path";
import { parseArgs } from "node:util";
import { formatResult } from "./format.js";
import { PoliteFetcher } from "./http.js";
import { DEFAULT_OPTIONS, findRoutes } from "./search.js";
import { FlightsFromSource } from "./sources/flightsfrom.js";
import { InMemorySource } from "./sources/memory.js";
import { sampleFlights } from "./sources/sample.js";
import type { FlightDataSource } from "./types.js";
import { loadWhitelist, parseCarrierCodes, saveWhitelist, settingsPath } from "./whitelist.js";

const USAGE = `Usage:
  npm run zed -- whitelist                       Show your airline whitelist
  npm run zed -- whitelist set AC,LH,UA          Replace it
  npm run zed -- whitelist add WS                Add airlines
  npm run zed -- whitelist remove LH             Remove airlines

  npm run zed -- search --from YYZ --to LHR --date 2026-11-02 [options]
    --depart-after HH:mm    --depart-before HH:mm   (origin local time)
    --arrive-after HH:mm    --arrive-before HH:mm   (destination local time)
    --min-connection MIN    default ${DEFAULT_OPTIONS.minConnectionMinutes}
    --max-layover MIN       default ${DEFAULT_OPTIONS.maxLayoverMinutes}
    --demo                  use made-up sample schedules instead of flightsfrom.com`;

async function whitelistCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const current = await loadWhitelist();
  if (!action) {
    console.log(current.length ? current.join(", ") : "(empty)");
    console.log(`Saved in ${settingsPath()}`);
    return;
  }
  const codes = parseCarrierCodes(rest);
  let next: string[];
  if (action === "set") next = codes;
  else if (action === "add") next = [...current, ...codes];
  else if (action === "remove") next = current.filter((c) => !codes.includes(c));
  else throw new Error(`Unknown whitelist action "${action}"\n\n${USAGE}`);
  await saveWhitelist(next);
  console.log(`Whitelist: ${parseCarrierCodes(next).join(", ") || "(empty)"}`);
}

async function searchCommand(args: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      date: { type: "string" },
      "depart-after": { type: "string" },
      "depart-before": { type: "string" },
      "arrive-after": { type: "string" },
      "arrive-before": { type: "string" },
      "min-connection": { type: "string" },
      "max-layover": { type: "string" },
      demo: { type: "boolean", default: false },
    },
  });
  if (!v.from || !v.to || !v.date) throw new Error(`--from, --to and --date are required\n\n${USAGE}`);

  const whitelist = await loadWhitelist();
  if (whitelist.length === 0) {
    console.log("Your airline whitelist is empty. Set it first, e.g.:\n  npm run zed -- whitelist set AC,LH,UA");
    process.exitCode = 1;
    return;
  }

  let source: FlightDataSource;
  if (v.demo) {
    console.log("*** DEMO MODE: made-up sample schedules, not real flights ***\n");
    source = new InMemorySource(sampleFlights(v.date));
  } else {
    const fetcher = new PoliteFetcher({
      cacheDir: join(process.cwd(), ".cache", "http"),
      userAgent: "zed-routes/0.1 (personal staff-travel route finder PoC)",
      minIntervalMs: 1000,
    });
    source = new FlightsFromSource(fetcher);
  }

  const toMinutes = (s: string | undefined, name: string) => {
    if (s === undefined) return undefined;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number of minutes`);
    return n;
  };

  const result = await findRoutes(
    {
      origin: v.from,
      destination: v.to,
      date: v.date,
      whitelist,
      departAfter: v["depart-after"],
      departBefore: v["depart-before"],
      arriveAfter: v["arrive-after"],
      arriveBefore: v["arrive-before"],
    },
    source,
    {
      minConnectionMinutes: toMinutes(v["min-connection"], "min-connection") ?? DEFAULT_OPTIONS.minConnectionMinutes,
      maxLayoverMinutes: toMinutes(v["max-layover"], "max-layover") ?? DEFAULT_OPTIONS.maxLayoverMinutes,
    },
  );
  console.log(`${v.from.toUpperCase()} → ${v.to.toUpperCase()} on ${v.date}, airlines: ${whitelist.join(", ")}`);
  console.log(formatResult(result));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "whitelist") return whitelistCommand(rest);
  if (command === "search") return searchCommand(rest);
  console.log(USAGE);
  if (command && command !== "help") process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
