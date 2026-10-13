import JSON5 from "json5";
import type { CarrierCode } from "./types.js";

/**
 * OAL ("other airline") files: the list of carriers an airline has ZED
 * agreements with, as published for its staff. The format is a JavaScript
 * object literal (`var OAL_DATA = { _LH: { oalName, iata, zedY, zedJ, other } }`).
 *
 * Files are parsed as data with JSON5 and never executed, because people
 * import files they got from someone else.
 */

export const TRAVELLER_TYPES = ["employee", "retiree", "spouse", "children", "parent", "partner"] as const;
export type TravellerType = (typeof TRAVELLER_TYPES)[number];
export type Cabin = "economy" | "business";
/** ZED fare level as written in the file, e.g. "ZL", "ZM", "ZH", "ZN". */
export type FareLevel = string;

export interface OalAirline {
  /** IATA code. Only for airlines without one, the 3-letter ICAO code (these can't match flight data). */
  code: CarrierCode;
  name: string;
  /** Fare level per traveller type. Types the airline doesn't allow are left out. */
  economy: Partial<Record<TravellerType, FareLevel>>;
  business: Partial<Record<TravellerType, FareLevel>>;
  /** Regional airlines flying for this one (from the file's `otherAirlines` note). Same fares apply. */
  affiliates: CarrierCode[];
}

export interface ParsedOal {
  airlines: OalAirline[];
  warnings: string[];
}

/**
 * Codes in `otherAirlines` notes that point at the wrong airline, keyed by
 * "PARENT:CODE". Dropped so the search never offers an airline the employee
 * can't fly.
 */
const WRONG_AFFILIATE_CODES: Record<string, string> = {
  "JL:OD": "JALways (JO) merged into JAL in 2010; OD is Batik Air Malaysia",
  "AA:OW": "Executive Airlines stopped flying in 2013; OW now belongs to another airline",
};

const IATA = /^[A-Z0-9]{2}$/;
const ICAO = /^[A-Z]{3}$/;

function fares(raw: unknown): Partial<Record<TravellerType, FareLevel>> {
  const out: Partial<Record<TravellerType, FareLevel>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const t of TRAVELLER_TYPES) {
    // 0 (or a missing field) means this traveller type isn't allowed.
    const v = (raw as Record<string, unknown>)[t];
    if (typeof v === "string" && v.trim()) out[t] = v.trim().toUpperCase();
  }
  return out;
}

/** Two-character codes in brackets: "United Express: Mesa(YV), Republic(YX)" → ["YV", "YX"]. */
function affiliateCodes(note: unknown): CarrierCode[] {
  if (typeof note !== "string") return [];
  return [...note.matchAll(/\(\s*([A-Z0-9]{2})\s*\)/g)].map((m) => m[1]!);
}

/** Parse the text of an OAL file. Throws if it isn't one. */
export function parseOal(text: string): ParsedOal {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Not an OAL file: no { ... } object found.");
  let data: unknown;
  try {
    data = JSON5.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Not an OAL file: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Not an OAL file: expected an object of airlines.");

  const airlines: OalAirline[] = [];
  const warnings: string[] = [];
  const seen = new Set<CarrierCode>();
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const code = String(e.iata ?? "").trim().toUpperCase();
    const name = String(e.oalName ?? code);
    if (!IATA.test(code) && !ICAO.test(code)) {
      warnings.push(`Skipped ${key} (${name}): "${code}" is not an airline code.`);
      continue;
    }
    if (ICAO.test(code)) warnings.push(`${code} ${name} has no IATA code, so it won't match any flights.`);
    if (seen.has(code)) {
      warnings.push(`Skipped a second entry for ${code} (${name}).`);
      continue;
    }
    seen.add(code);

    const other = (e.other ?? {}) as Record<string, unknown>;
    const affiliates = affiliateCodes(other.otherAirlines).filter((a) => {
      const wrong = WRONG_AFFILIATE_CODES[`${code}:${a}`];
      if (wrong) warnings.push(`Ignored ${a} listed under ${code} ${name}: ${wrong}.`);
      return !wrong && a !== code;
    });
    airlines.push({ code, name, economy: fares(e.zedY), business: fares(e.zedJ), affiliates: [...new Set(affiliates)] });
  }
  if (airlines.length === 0) throw new Error("Not an OAL file: no airlines with codes found.");
  airlines.sort((a, b) => a.code.localeCompare(b.code));
  return { airlines, warnings };
}

// ---------------------------------------------------------------------------
// Eligibility: which operating carriers a given traveller can fly, and at what fare
// ---------------------------------------------------------------------------

export interface CarrierEligibility {
  code: CarrierCode;
  name: string;
  /** "staff" for the home airline; otherwise the ZED fare level per cabin allowed. */
  fare: "staff" | { economy?: FareLevel; business?: FareLevel };
  /** Set when the carrier is a regional flying for an OAL airline (or for the home airline). */
  via?: CarrierCode;
}

export interface EligibilityOptions {
  traveller: TravellerType;
  cabins: Cabin[];
  /** The user's own airline and its regionals. Allowed for every traveller type and cabin. */
  home: CarrierCode[];
}

/** Every operating carrier the traveller may fly, keyed by code. */
export function eligibleCarriers(airlines: OalAirline[], opts: EligibilityOptions): Map<CarrierCode, CarrierEligibility> {
  const out = new Map<CarrierCode, CarrierEligibility>();
  const homeCarrier = opts.home[0];
  for (const code of opts.home) {
    const name = code === homeCarrier ? "home airline" : `regional for ${homeCarrier}`;
    out.set(code, { code, name, fare: "staff", via: code === homeCarrier ? undefined : homeCarrier });
  }
  const affiliates: CarrierEligibility[] = [];
  for (const a of airlines) {
    if (out.has(a.code)) continue;
    const fare: { economy?: FareLevel; business?: FareLevel } = {};
    if (opts.cabins.includes("economy") && a.economy[opts.traveller]) fare.economy = a.economy[opts.traveller];
    if (opts.cabins.includes("business") && a.business[opts.traveller]) fare.business = a.business[opts.traveller];
    if (!fare.economy && !fare.business) continue;
    out.set(a.code, { code: a.code, name: a.name, fare });
    for (const r of a.affiliates) affiliates.push({ code: r, name: `regional for ${a.name}`, fare, via: a.code });
  }
  // An airline's own entry beats being listed as someone else's regional.
  for (const r of affiliates) if (!out.has(r.code)) out.set(r.code, r);
  return out;
}

/** Short label for a results line: "staff travel", "ZM", "Y ZL / J ZM", "ZL via AS". */
export function fareLabel(e: CarrierEligibility): string {
  if (e.fare === "staff") return "staff travel";
  const { economy, business } = e.fare;
  const level = economy && business ? `Y ${economy} / J ${business}` : business ? `J ${business}` : economy!;
  return e.via ? `${level} via ${e.via}` : level;
}
