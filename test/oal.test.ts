import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eligibleCarriers, fareLabel, parseOal, type EligibilityOptions } from "../src/oal.js";

// Same shape as the real file: a script, unquoted keys, trailing commas, 0 for "not allowed".
const SAMPLE = `var OAL_DATA = {
  _LH: {
    oalName: "Lufthansa",
    iata: "LH",
    zedY: { employee: "ZN", retiree: "ZN", spouse: "ZN", children: "ZN", parent: 0, partner: 0 },
    zedJ: { employee: "ZM", spouse: 0, children: 0, parent: 0, partner: 0 },
    other: { otherAirlines: 0 },
  },
  _UA: {
    oalName: "United Airlines",
    iata: "UA",
    zedY: { employee: "ZL", retiree: "ZL", spouse: "ZL", children: "ZL", parent: "ZM", partner: "ZM" },
    zedJ: { employee: 0, spouse: 0, children: 0, parent: 0, partner: 0 },
    other: { otherAirlines: "United Express: Mesa(YV), SkyWest(OO), Go Jet(G7)" },
  },
  _B0: {
    oalName: "La Compagnie",
    iata: "B0",
    zedY: { employee: 0, retiree: 0, spouse: 0, children: 0, parent: 0, partner: 0 },
    zedJ: { employee: "ZL", spouse: "ZL", children: 0, parent: 0, partner: 0 },
    other: {},
  },
  _JL: {
    oalName: "Japan Airlines",
    iata: "JL",
    zedY: { employee: "ZM", retiree: "ZM", spouse: "ZM", children: "ZM", parent: 0, partner: 0 },
    zedJ: { employee: 0 },
    other: { otherAirlines: "Japan Airlines Domestic, Jalways (OD)" },
  },
  ECA: {
    oalName: "Excellent Air",
    iata: "ECA",
    zedY: { employee: "ZL" },
  },
  _OO: {
    oalName: "SkyWest",
    iata: "OO",
    zedY: { employee: "ZH" },
  },
}`;

const opts = (over: Partial<EligibilityOptions> = {}): EligibilityOptions => ({
  traveller: "employee",
  cabins: ["economy"],
  home: ["AC", "QK"],
  ...over,
});

describe("parseOal", () => {
  const { airlines, warnings } = parseOal(SAMPLE);
  const byCode = (c: string) => airlines.find((a) => a.code === c);

  it("reads fares per traveller type and treats 0 as not allowed", () => {
    expect(byCode("LH")).toMatchObject({
      name: "Lufthansa",
      economy: { employee: "ZN", retiree: "ZN", spouse: "ZN", children: "ZN" },
      business: { employee: "ZM" },
    });
    expect(byCode("LH")!.economy.parent).toBeUndefined();
  });

  it("pulls regional airline codes out of the otherAirlines note", () => {
    expect(byCode("UA")!.affiliates).toEqual(["YV", "OO", "G7"]);
  });

  it("drops regional codes known to point at the wrong airline", () => {
    expect(byCode("JL")!.affiliates).toEqual([]);
    expect(warnings.join("\n")).toMatch(/Ignored OD listed under JL/);
  });

  it("keeps airlines with only an ICAO code but warns they can't match flights", () => {
    expect(byCode("ECA")).toBeDefined();
    expect(warnings.join("\n")).toMatch(/ECA Excellent Air has no IATA code/);
  });

  it("does not run the file", () => {
    expect(() => parseOal(`var OAL_DATA = { _XX: { iata: "XX", zedY: { employee: (() => "ZL")() } } }`)).toThrow(/Not an OAL file/);
    expect(() => parseOal("process.exit(1)")).toThrow(/Not an OAL file/);
  });

  it("accepts a plain JSON export", () => {
    const json = JSON.stringify({ LH: { oalName: "Lufthansa", iata: "LH", zedY: { employee: "ZN" } } });
    expect(parseOal(json).airlines.map((a) => a.code)).toEqual(["LH"]);
  });

  it("parses the bundled Air Canada oal.js", async () => {
    const real = parseOal(await readFile(new URL("../oal.js", import.meta.url), "utf8"));
    expect(real.airlines).toHaveLength(174);
    const codes = real.airlines.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(["YB", "VJT", "ECA", "LH", "UA", "B0"]));
    expect(codes).not.toEqual(expect.arrayContaining(["77"]));
    expect(codes).not.toEqual(expect.arrayContaining(["02"]));
    expect(codes).not.toContain("AC"); // the home airline isn't an OAL
    expect(real.airlines.find((a) => a.code === "AS")!.affiliates).toEqual(["QX"]);
  });
});

describe("eligibleCarriers", () => {
  const { airlines } = parseOal(SAMPLE);

  it("allows the home airline and its regionals on staff travel, for every traveller type", () => {
    const c = eligibleCarriers(airlines, opts({ traveller: "partner" }));
    expect(c.get("AC")!.fare).toBe("staff");
    expect(c.get("QK")).toMatchObject({ fare: "staff", via: "AC" });
  });

  it("filters OAL airlines by traveller type", () => {
    expect([...eligibleCarriers(airlines, opts()).keys()].sort()).toEqual(
      ["AC", "ECA", "G7", "JL", "LH", "OO", "QK", "UA", "YV"].sort(),
    );
    // Parents: only United (ZM) and its regionals.
    const parent = eligibleCarriers(airlines, opts({ traveller: "parent" }));
    expect([...parent.keys()].sort()).toEqual(["AC", "G7", "OO", "QK", "UA", "YV"]);
    expect(fareLabel(parent.get("UA")!)).toBe("ZM");
  });

  it("gives regionals the fare of the airline they fly for, unless they have their own entry", () => {
    const c = eligibleCarriers(airlines, opts());
    expect(fareLabel(c.get("YV")!)).toBe("ZL via UA");
    expect(fareLabel(c.get("OO")!)).toBe("ZH");
  });

  it("leaves business fares out unless asked", () => {
    expect(eligibleCarriers(airlines, opts()).has("B0")).toBe(false);
    const both = eligibleCarriers(airlines, opts({ cabins: ["economy", "business"] }));
    expect(fareLabel(both.get("B0")!)).toBe("J ZL");
    expect(fareLabel(both.get("LH")!)).toBe("Y ZN / J ZM");
  });

  it("has no business fare for retirees when the file doesn't list one", () => {
    const c = eligibleCarriers(airlines, opts({ traveller: "retiree", cabins: ["economy", "business"] }));
    expect(c.has("B0")).toBe(false);
    expect(fareLabel(c.get("LH")!)).toBe("ZN");
  });
});
