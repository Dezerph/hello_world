import { describe, expect, it } from "vitest";
import {
  candidateHubs,
  dedupeCodeshares,
  EmptyWhitelistError,
  findRoutes,
  leg2Dates,
  pairFlights,
  type SearchRequest,
} from "../src/search.js";
import { InMemorySource } from "../src/sources/memory.js";
import { f } from "./helpers.js";

const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  origin: "LHR",
  destination: "YVR",
  date: "2026-11-02",
  whitelist: ["AC", "BA"],
  ...over,
});

describe("pairFlights", () => {
  const leg1 = f("LHR-YYZ", "AC869", "2026-11-02T09:45", "2026-11-02T12:40");

  it("pairs a valid connection and computes times across time zones", () => {
    const leg2 = f("YYZ-YVR", "AC105", "2026-11-02T14:30", "2026-11-02T16:45");
    const [it1, ...rest] = pairFlights([leg1], [leg2], req());
    expect(rest).toHaveLength(0);
    expect(it1).toMatchObject({ connection: "YYZ", layoverMinutes: 110, overnightConnection: false, arrivalDayOffset: 0 });
    // 09:45 London (UTC) → 16:45 Vancouver (UTC-8) = 15h
    expect(it1!.totalMinutes).toBe(15 * 60);
  });

  it("rejects connections shorter than the minimum", () => {
    const tight = f("YYZ-YVR", "AC105", "2026-11-02T14:00", "2026-11-02T16:15");
    expect(pairFlights([leg1], [tight], req())).toEqual([]);
    expect(pairFlights([leg1], [tight], req(), { minConnectionMinutes: 60 })).toHaveLength(1);
  });

  it("rejects layovers longer than the maximum", () => {
    const late = f("YYZ-YVR", "AC101", "2026-11-03T06:00", "2026-11-03T08:20");
    expect(pairFlights([leg1], [late], req())).toEqual([]); // 17h20
    expect(pairFlights([leg1], [late], req(), { maxLayoverMinutes: 18 * 60 })).toHaveLength(1);
  });

  it("flags overnight connections and next-day arrivals", () => {
    const evening = f("LHR-YYZ", "BA93", "2026-11-02T15:15", "2026-11-02T18:10");
    const morning = f("YYZ-YVR", "AC101", "2026-11-03T06:00", "2026-11-03T08:20");
    const [it1] = pairFlights([evening], [morning], req());
    expect(it1).toMatchObject({ overnightConnection: true, arrivalDayOffset: 1, layoverMinutes: 11 * 60 + 50 });
  });

  it("handles crossing the date line", () => {
    // LAX → NRT arrives the next day; NRT → SIN same local day as arrival.
    const a = f("LAX-NRT", "JL61", "2026-11-02T11:00", "2026-11-03T15:00");
    const b = f("NRT-SIN", "JL711", "2026-11-03T17:30", "2026-11-03T23:55");
    const [it1] = pairFlights([a], [b], req({ origin: "LAX", destination: "SIN", whitelist: ["JL"] }));
    // 11:00 PST (UTC-8) = 19:00Z; 23:55 SGT (UTC+8) = 15:55Z next day → 20h55
    expect(it1).toMatchObject({ layoverMinutes: 150, totalMinutes: 20 * 60 + 55, arrivalDayOffset: 1, overnightConnection: false });
  });

  it("filters on the operating carrier, not the marketing carrier", () => {
    const codeshareOperatedByOther = f("YYZ-YVR", "AC8001", "2026-11-02T15:00", "2026-11-02T17:00", { op: "WS" });
    expect(pairFlights([leg1], [codeshareOperatedByOther], req())).toEqual([]);
    const marketedByOtherOperatedByUs = f("YYZ-YVR", "UA7000", "2026-11-02T15:00", "2026-11-02T17:00", { op: "AC" });
    expect(pairFlights([leg1], [marketedByOtherOperatedByUs], req())).toHaveLength(1);
  });

  it("allows mixing airlines across the two legs", () => {
    const ba = f("LHR-YYZ", "BA93", "2026-11-02T09:00", "2026-11-02T12:00");
    const ac = f("YYZ-YVR", "AC105", "2026-11-02T14:30", "2026-11-02T16:45");
    expect(pairFlights([ba], [ac], req())).toHaveLength(1);
  });

  it("applies departure and arrival time windows in local time", () => {
    const early = f("LHR-YYZ", "AC869", "2026-11-02T09:45", "2026-11-02T12:40");
    const late = f("LHR-YYZ", "BA93", "2026-11-02T15:15", "2026-11-02T18:10");
    const l2a = f("YYZ-YVR", "AC105", "2026-11-02T14:30", "2026-11-02T16:45");
    const l2b = f("YYZ-YVR", "AC115", "2026-11-02T20:00", "2026-11-02T22:20");
    const dep = pairFlights([early, late], [l2a, l2b], req({ departAfter: "12:00" }));
    expect(dep.map((i) => i.leg1.flightNumber)).toEqual(["BA93"]);
    const arr = pairFlights([early, late], [l2a, l2b], req({ arriveBefore: "18:00" }));
    expect(arr.map((i) => i.leg2.flightNumber)).toEqual(["AC105"]);
  });

  it("ignores leg-1 flights that depart on another date", () => {
    const otherDay = f("LHR-YYZ", "AC869", "2026-11-03T09:45", "2026-11-03T12:40");
    const l2 = f("YYZ-YVR", "AC105", "2026-11-03T14:30", "2026-11-03T16:45");
    expect(pairFlights([otherDay], [l2], req())).toEqual([]);
  });

  it("sorts by total journey time", () => {
    const l1 = f("LHR-YYZ", "AC869", "2026-11-02T09:45", "2026-11-02T12:40");
    const slow = f("YYZ-YVR", "AC115", "2026-11-02T19:30", "2026-11-02T21:47");
    const fast = f("YYZ-YVR", "AC105", "2026-11-02T14:30", "2026-11-02T16:45");
    expect(pairFlights([l1], [slow, fast], req()).map((i) => i.leg2.flightNumber)).toEqual(["AC105", "AC115"]);
  });
});

describe("dedupeCodeshares", () => {
  it("keeps one listing per physical flight, preferring the operator's own number", () => {
    const own = f("LHR-YYZ", "BA93", "2026-11-02T15:15", "2026-11-02T18:10");
    const cs = f("LHR-YYZ", "AC5501", "2026-11-02T15:15", "2026-11-02T18:10", { op: "BA" });
    expect(dedupeCodeshares([cs, own])).toEqual([own]);
  });
});

describe("candidateHubs", () => {
  it("intersects the whitelisted spokes of both ends", () => {
    const wl = new Set(["AC", "UA"]);
    const fromO = [
      { station: "YYZ", carriers: ["AC"] },
      { station: "ORD", carriers: ["UA"] },
      { station: "SEA", carriers: ["BA"] },
      { station: "YVR", carriers: ["AC"] },
    ];
    const fromD = [
      { station: "YYZ", carriers: ["AC"] },
      { station: "ORD", carriers: ["UA"] },
      { station: "SEA", carriers: ["AS"] },
      { station: "LHR", carriers: ["AC"] },
    ];
    expect(candidateHubs(fromO, fromD, wl, "LHR", "YVR")).toEqual(["ORD", "YYZ"]);
  });
});

describe("leg2Dates", () => {
  it("covers every hub-local date a connection could leave on", () => {
    const l1 = f("LHR-YYZ", "BA93", "2026-11-02T15:15", "2026-11-02T18:10");
    expect(leg2Dates([l1])).toEqual(["2026-11-02", "2026-11-03"]);
    expect(leg2Dates([l1], { maxLayoverMinutes: 60 * 5 })).toEqual(["2026-11-02"]);
  });
});

describe("findRoutes", () => {
  const flights = [
    f("LHR-YYZ", "AC869", "2026-11-02T09:45", "2026-11-02T12:40"),
    f("YYZ-YVR", "AC105", "2026-11-02T14:30", "2026-11-02T16:45"),
    f("YVR-YYZ", "AC100", "2026-11-02T08:00", "2026-11-02T15:30"),
    // Triangle: YVR → YUL exists, YUL → YVR does not.
    f("LHR-YUL", "AC865", "2026-11-02T12:00", "2026-11-02T14:30"),
    f("YVR-YUL", "AC302", "2026-11-02T09:00", "2026-11-02T16:20"),
    // Overnight connection needs next-day leg 2 schedules.
    f("LHR-YYZ", "BA93", "2026-11-02T15:15", "2026-11-02T18:10"),
    f("YYZ-YVR", "AC101", "2026-11-03T06:00", "2026-11-03T08:20"),
  ];

  it("finds routes through shared spokes and skips one-way hubs", async () => {
    const source = new InMemorySource(flights);
    const result = await findRoutes(req(), source);
    expect(result.hubsConsidered).toEqual(["YUL", "YYZ"]);
    expect(result.hubsSkipped).toEqual([{ hub: "YUL", reason: "no YUL→YVR route on a whitelisted airline" }]);
    expect(result.itineraries.map((i) => `${i.leg1.flightNumber}+${i.leg2.flightNumber}`)).toEqual([
      "AC869+AC105",
      "BA93+AC101",
    ]);
    expect(source.calls).toContain("flights YYZ-YVR 2026-11-03");
    expect(source.calls).not.toContain("flights LHR-YUL 2026-11-02");
  });

  it("refuses to search with an empty whitelist", async () => {
    await expect(findRoutes(req({ whitelist: [] }), new InMemorySource(flights))).rejects.toThrow(EmptyWhitelistError);
  });

  it("accepts lower-case input", async () => {
    const result = await findRoutes(req({ origin: "lhr", destination: "yvr", whitelist: ["ac", "ba"] }), new InMemorySource(flights));
    expect(result.itineraries).toHaveLength(2);
  });
});
