# CLAUDE.md

Project context for Claude Code and other contributors.

## What this project is

A route finder for airline employees who travel standby on staff ("ZED") fares.
The user picks an origin station, a destination station, a date and an optional
time window. The app returns every routing with **one layover** (two flight
segments) between the two stations. The two segments can be on different
airlines, as long as staff travel is allowed on each one.

The main use case is an employee getting **home** from a work location or a trip,
so results should help them choose the routing with the best chance of
getting on board.

## Domain glossary

- **Station**: an airport, identified by its 3-letter IATA code (e.g. `LHR`, `JFK`).
- **Standby / non-rev**: the employee has no confirmed seat. They board only if
  seats are left after paying passengers are accommodated.
- **ZED (Zonal Employee Discount)**: the industry framework for discounted staff
  travel on *other* airlines. Fares are set by the flight's distance zone and a
  fare level (commonly Low / Medium / High) agreed between the two airlines.
- **ZED / interline agreement**: a bilateral agreement between the employee's
  airline and another carrier. Staff can only fly ZED on carriers their airline
  has an agreement with. (MIBA, the Multilateral Interline Benefits Agreement,
  is a related framework some carriers use.)
- **Home carrier**: the airline the user works for. Its own flights are usually
  available under a separate staff travel scheme, not ZED.
- **Operating vs. marketing carrier**: codeshares are sold under one airline's
  code but flown by another. Staff travel eligibility usually depends on the
  **operating** carrier, so filtering must use it.
- **Segment**: a single flight between two stations. A one-layover route has
  two segments: origin → connection → destination.
- **MCT (Minimum Connection Time)**: the shortest legal connection at an airport.
  ZED tickets are normally separate tickets, so the employee self-transfers (may
  need to re-check bags or clear immigration). The app should apply a buffer
  above MCT.

## Core user flow

1. Select **origin** station (searchable airport picker).
2. Select **destination** station.
3. Pick a **date** with a date picker.
4. Optionally give a **departure and/or arrival time window**.
5. Submit. The app lists every eligible 1-layover route:
   - Leg 1: carrier, flight number, departure and arrival times
   - Connection station and layover duration
   - Leg 2: carrier, flight number, departure and arrival times
   - Total journey time
   - (Later) fare zone and level, plus a standby-load indicator if the data exists

## Routing rules

- A route is exactly `origin → X → destination`, where `X` is neither the
  origin nor the destination.
- Both segments must be on an **operating carrier in the user's airline
  whitelist** (see below). The two segments do **not** have to be on the same
  airline. Any whitelisted carrier can be paired with any other.
- Leg 2 must depart at least `MCT + buffer` after leg 1 arrives at `X`.
  Defaults are open to change; until decided, use ~90 min for an international
  self-transfer and cap layovers at ~12 h.
- Use the **local time** of each station for display. Use UTC (or tz-aware
  datetimes) for every comparison, because routes cross time zones and the date line.
- The time window filters on leg 1 departure and/or leg 2 arrival.
- Connections that run overnight (leg 2 on the next day) should be supported
  but flagged.
- Sort by total journey time by default.

## Airline whitelist: the OAL file

The user works for **Air Canada**. The airlines they can fly are AC itself (plus
its regionals Jazz `QK` and Rouge `RV`, on staff travel) and every carrier in
`oal.js`, AC's list of ZED ("other airline", OAL) agreements. The app does not
try to work out ZED agreements itself.

- `oal.js` is a JavaScript object literal (`var OAL_DATA = { _LH: {...} }`). Each
  airline has `iata`, `oalName`, `zedY` / `zedJ` (economy / business) with a fare
  level per traveller type (`employee`, `retiree`, `spouse`, `children`,
  `parent`, `partner`; `0` = that type is not allowed; `zedJ` has no `retiree`),
  and `other.otherAirlines`, a note naming regionals that fly for it, e.g.
  "United Express: Mesa(YV), SkyWest(OO)".
- `src/oal.ts` parses it **as data with JSON5, never by running it**, because
  users import files from other people. Codes in brackets in `otherAirlines` are
  allowed too, at the parent's fares; codes known to be wrong there (JL's "OD",
  AA's "OW") are dropped. Airlines with only an ICAO code (ECA, VJT) are kept but
  can't match flights.
- Search eligibility = home airlines (any traveller type, any cabin) + OAL
  airlines whose fare for the chosen traveller type is non-zero. Default:
  `employee`, economy only. `--business` also counts `zedJ`.
- Every search filters both legs on it, matching the **operating** carrier.
  Results show each leg's fare level (`ZL`, `Y ZL / J ZM`, `ZL via UA`, `staff travel`).
- Profiles (`src/profiles.ts`): the built-in `ac` profile reads the repo's
  `oal.js`. Other users import their own OAL file under a name, with their home
  airline; it is saved as parsed JSON in `~/.zed-routes/oal/NAME.json` and the
  active profile in `~/.zed-routes/settings.json` (`ZED_SETTINGS` overrides).
- If no airline is eligible, show a prompt instead of results.

## Current data source: AeroDataBox

`src/sources/aerodatabox.ts` is the default source (key in `AERODATABOX_API_KEY`,
RapidAPI). Routes come from `/airports/iata/{code}/stats/routes/daily/{date}`,
schedules from the FIDS departures endpoint (12 h max window, so two calls per
airport-day, cached and shared across destinations). Codeshare entries are
dropped and the operator's own flight is kept. Fixtures are hand-written from
the API models, not recorded; replace them with real responses. flightsfrom.com
is blocked by a Cloudflare challenge, so its adapter stays an unimplemented stub.
The section below is the original plan, kept for the algorithm.

## PoC data source: flightsfrom.com (hub and spoke)

For the proof of concept, route and schedule data comes from
[flightsfrom.com](https://www.flightsfrom.com). Its page
`https://www.flightsfrom.com/{IATA}/destinations` lists every station served
non-stop from `{IATA}` (the station's "spokes") and the airlines flying each route.

Search algorithm:

1. Fetch the spokes of the **origin** (`/ORIG/destinations`). Keep only routes
   flown by a whitelisted airline.
2. Fetch the spokes of the **destination** (`/DEST/destinations`), filtered the
   same way.
3. **Candidate connections** = the stations in both spoke sets, minus origin and destination.
4. **Verify the direction of leg 2.** Step 2 lists flights *out of* DEST, but we
   need flights *into* DEST. Most routes run both ways, but some don't (e.g.
   triangle routings). For each candidate `X`, confirm on `/X/destinations` that
   a whitelisted airline flies `X → DEST`.
5. For each surviving `X`, fetch the dated schedules for `ORIG → X` and
   `X → DEST`. Then pair flights using the connection rules above.

Fetch rules:

- **Cache aggressively.** Route lists change slowly, so cache destination pages
  for at least 24 h. Schedules can be cached for a few hours.
- Throttle requests (about 1 per second, never in parallel against the site),
  send an honest User-Agent, and respect `robots.txt`.
- Check the site's terms of use before relying on it beyond personal PoC use.
- The page layout can change without notice. Keep all parsing code in one adapter
  module and back it with saved HTML fixtures in tests.

Keep the data source behind an interface so a licensed schedule API can replace it:

```
get_routes_from(station) -> [(dest_station, [carrier_codes])]
get_flights(origin, dest, date) -> [Flight(carrier, flight_no, dep_local, arr_local, operating_carrier)]
```

## Data the app needs

| Data | Purpose | Notes |
|---|---|---|
| Airports | Station picker, time zones | Open datasets exist (e.g. OurAirports + IANA tz) |
| Routes and flight schedules | Building the segments | PoC: flightsfrom.com (see above). Later: maybe a licensed schedules API (OAG, Cirium, AeroDataBox, etc.) |
| Airline whitelist | Filtering by carrier eligibility | `oal.js` for AC; other users import their own OAL file (see above) |
| MCT per airport | Connection validity | Use a configurable default to start |

Do not scrape airline or staff-travel portals. They usually require staff
credentials and their terms forbid automated access.

## Open questions (decide before building much)

- UI platform (web app, mobile, or both). The PoC is a TypeScript CLI.
- Exactly which flightsfrom.com page holds the dated flight times for a
  route, and how it's structured (not checked yet; the parsers in
  `src/sources/flightsfrom.ts` are stubs until real pages are saved as fixtures).
- Do flightsfrom.com route lists show operating or marketing carriers? The
  route-level whitelist filter assumes operating.
- Long-term schedule data provider: cost, coverage and rate limits.
- Should **direct flights** appear alongside the 1-layover routes?
- Will 2-layover routes be needed later? (Design the search so the number of hops can be raised.)
- Are standby load or seat availability indicators needed, and is there a legitimate source for them?

## Stack and layout

TypeScript on Node 20+ (ESM), `luxon` for time zones, `vitest` for tests, `tsx` to run.

```
src/types.ts              Flight, RouteInfo, FlightDataSource interface
src/search.ts             Pure pairing logic + findRoutes() hub-and-spoke orchestration
src/timezones.ts          Station → IANA zone (small hand-kept list; PoC stopgap)
src/http.ts               PoliteFetcher: file cache, 1 req/s queue, robots.txt
src/sources/aerodatabox.ts  AeroDataBox adapter (default)
src/sources/flightsfrom.ts  flightsfrom.com adapter (stub; site blocks scripts)
src/sources/memory.ts     In-memory source for tests and --demo
src/sources/sample.ts     Made-up demo schedules
src/oal.ts                OAL file parser + eligibility by traveller type and cabin (pure)
src/profiles.ts           Built-in AC profile and imported OAL profiles, saved under ~/.zed-routes
oal.js                    Air Canada's OAL (ZED agreement) list
src/cli.ts, src/format.ts CLI
test/                     vitest tests
```

Commands:

- `npm test`, `npm run typecheck`
- `npm run zed -- oal [--traveller spouse] [--business]` (show who you can fly)
- `npm run zed -- oal import their-oal.js --name jane --home WS`, `oal use jane`, `oal list`
- `npm run zed -- search --from LHR --to YVR --date 2026-11-02 [--traveller TYPE] [--business] [--demo]`

In a cloud session behind the egress proxy, Node's `fetch` needs
`NODE_USE_ENV_PROXY=1` to use `HTTPS_PROXY`.

## Conventions

- Keep the routing/search logic **pure and separate** from data fetching and UI,
  so it can be unit-tested with fixture schedules.
- Write tests for the edge cases: time zones, date-line crossing, overnight
  connections, connections that are too tight, and codeshare (operating vs.
  marketing) filtering.
- Never commit API keys. Load them from environment variables.
