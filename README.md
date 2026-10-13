# zed-routes

Finds one-layover standby (ZED) routings between two stations, using only the
airlines you're allowed to fly on. See `CLAUDE.md` for the full project context.

**Status:** proof of concept. Route and flight data come from the
[OpenSky Network](https://opensky-network.org) API. OpenSky only records flights
that have already flown, so times for your date are **estimates**: the flights
seen on the same weekday in a recent week, roughly take-off and landing times.
Use `--demo` to try the search on made-up schedules without an OpenSky account.

```sh
npm install
npm run zed -- whitelist set AC,BA,UA,WS
npm run zed -- search --from LHR --to YVR --date 2026-11-02 --demo

export OPENSKY_CLIENT_ID=...  OPENSKY_CLIENT_SECRET=...   # API client from your OpenSky account
npm run zed -- search --from LHR --to YVR --date 2026-11-02
npm test
```
