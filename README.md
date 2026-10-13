# zed-routes

Finds one-layover standby (ZED) routings between two stations, using only the
airlines you're allowed to fly on. See `CLAUDE.md` for the full project context.

**Status:** proof of concept. The search, airline whitelist and polite fetcher
work and are tested. The flightsfrom.com page parsers are not written yet, so
real searches stop with a "not implemented" error. Use `--demo` to try the
search on made-up schedules.

```sh
npm install
npm run zed -- whitelist set AC,BA,UA,WS
npm run zed -- search --from LHR --to YVR --date 2026-11-02 --demo
npm test
```
