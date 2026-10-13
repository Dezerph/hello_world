# zed-routes

Finds one-layover standby (ZED) routings between two stations, using only the
airlines you're allowed to fly on. See `CLAUDE.md` for the full project context.

**Status:** proof of concept. The search, airline whitelist and fetcher are
tested. Real schedules come from [AeroDataBox](https://aerodatabox.com) (via
RapidAPI): set `AERODATABOX_API_KEY`. The adapter is tested only against
hand-written fixtures, because the API was not reachable when it was built, so
check it against real responses first. Use `--demo` to try the search on
made-up schedules.

```sh
npm install
npm run zed -- whitelist set AC,BA,UA,WS
npm run zed -- search --from LHR --to YVR --date 2026-11-02 --demo
npm test
```
