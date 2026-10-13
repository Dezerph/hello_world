import { join } from "node:path";
import { parseArgs } from "node:util";
import { formatResult } from "./format.js";
import { PoliteFetcher } from "./http.js";
import { eligibleCarriers, fareLabel, TRAVELLER_TYPES, type Cabin, type TravellerType } from "./oal.js";
import {
  activeProfileName,
  importProfile,
  listProfiles,
  loadActiveProfile,
  parseCarrierCodes,
  removeProfile,
  settingsPath,
  useProfile,
} from "./profiles.js";
import { DEFAULT_OPTIONS, findRoutes } from "./search.js";
import { AeroDataBoxSource } from "./sources/aerodatabox.js";
import { InMemorySource } from "./sources/memory.js";
import { sampleFlights } from "./sources/sample.js";
import type { FlightDataSource } from "./types.js";

const USAGE = `Usage:
  npm run zed -- oal [--traveller TYPE] [--business]   Show the airlines you can fly, with fare levels
  npm run zed -- oal list                              List OAL profiles (* = active)
  npm run zed -- oal import FILE --name NAME [--home WS,WR]
                                                       Save someone's OAL file as a profile
  npm run zed -- oal use NAME                          Search with that profile ("ac" = built-in Air Canada list)
  npm run zed -- oal remove NAME

  npm run zed -- search --from YYZ --to LHR --date 2026-11-02 [options]
    --depart-after HH:mm    --depart-before HH:mm   (origin local time)
    --arrive-after HH:mm    --arrive-before HH:mm   (destination local time)
    --min-connection MIN    default ${DEFAULT_OPTIONS.minConnectionMinutes}
    --max-layover MIN       default ${DEFAULT_OPTIONS.maxLayoverMinutes}
    --traveller TYPE        ${TRAVELLER_TYPES.join(" | ")} (default employee)
    --business              also allow airlines' business-class ZED fares
    --demo                  use made-up sample schedules instead of AeroDataBox

Real searches need AERODATABOX_API_KEY (your RapidAPI key for AeroDataBox).`;

function travellerOption(value: string | undefined): TravellerType {
  const t = (value ?? "employee").toLowerCase();
  if (!(TRAVELLER_TYPES as readonly string[]).includes(t)) throw new Error(`--traveller must be one of: ${TRAVELLER_TYPES.join(", ")}`);
  return t as TravellerType;
}

const cabinsOption = (business: boolean | undefined): Cabin[] => (business ? ["economy", "business"] : ["economy"]);

async function oalCommand(args: string[]): Promise<void> {
  const { values: v, positionals: words } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      home: { type: "string" },
      traveller: { type: "string" },
      business: { type: "boolean", default: false },
    },
  });
  const [action, ...positionals] = words;

  if (!action) {
    const profile = await loadActiveProfile();
    const traveller = travellerOption(v.traveller);
    const carriers = eligibleCarriers(profile.airlines, { traveller, cabins: cabinsOption(v.business), home: profile.home });
    console.log(`OAL profile "${profile.name}": ${carriers.size} airlines for ${traveller}${v.business ? " (economy or business)" : " (economy)"}`);
    for (const c of carriers.values()) console.log(`  ${c.code.padEnd(3)} ${c.name.padEnd(40)} ${fareLabel(c)}`);
    for (const w of profile.warnings) console.log(`  note: ${w}`);
    return;
  }
  if (action === "list") {
    const active = await activeProfileName();
    for (const name of await listProfiles()) console.log(`${name === active ? "*" : " "} ${name}`);
    console.log(`Saved in ${settingsPath()}`);
    return;
  }
  if (action === "import") {
    const [file] = positionals;
    if (!file || !v.name) throw new Error(`oal import needs a FILE and --name\n\n${USAGE}`);
    const profile = await importProfile(file, v.name, v.home ? parseCarrierCodes(v.home) : []);
    console.log(`Imported ${profile.airlines.length} airlines as "${profile.name}". Home airline: ${profile.home.join(", ") || "none"}.`);
    for (const w of profile.warnings) console.log(`  note: ${w}`);
    console.log(`Search with it after: npm run zed -- oal use ${profile.name}`);
    return;
  }
  if (action === "use" || action === "remove") {
    const [name] = positionals;
    if (!name) throw new Error(`oal ${action} needs a profile NAME\n\n${USAGE}`);
    if (action === "use") await useProfile(name);
    else await removeProfile(name);
    console.log(`Active OAL profile: ${await activeProfileName()}`);
    return;
  }
  throw new Error(`Unknown oal action "${action}"\n\n${USAGE}`);
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
      traveller: { type: "string" },
      business: { type: "boolean", default: false },
      demo: { type: "boolean", default: false },
    },
  });
  if (!v.from || !v.to || !v.date) throw new Error(`--from, --to and --date are required\n\n${USAGE}`);

  const profile = await loadActiveProfile();
  const traveller = travellerOption(v.traveller);
  const carriers = eligibleCarriers(profile.airlines, { traveller, cabins: cabinsOption(v.business), home: profile.home });
  if (carriers.size === 0) {
    console.log(`No airlines in OAL profile "${profile.name}" allow ${traveller} travel. Try another --traveller or --business.`);
    process.exitCode = 1;
    return;
  }
  const whitelist = [...carriers.keys()];

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
    source = new AeroDataBoxSource(fetcher, { apiKey: process.env.AERODATABOX_API_KEY ?? "" });
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
  console.log(
    `${v.from.toUpperCase()} → ${v.to.toUpperCase()} on ${v.date}: ${traveller}, ${v.business ? "economy or business" : "economy"}, ` +
      `${carriers.size} airlines from OAL profile "${profile.name}"`,
  );
  console.log(formatResult(result, (code) => {
    const c = carriers.get(code);
    return c && fareLabel(c);
  }));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "oal") return oalCommand(rest);
  if (command === "search") return searchCommand(rest);
  console.log(USAGE);
  if (command && command !== "help") process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
