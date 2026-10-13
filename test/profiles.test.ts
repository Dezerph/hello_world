import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeProfileName,
  BUILTIN_HOME,
  importProfile,
  listProfiles,
  loadActiveProfile,
  parseCarrierCodes,
  removeProfile,
  settingsPath,
  useProfile,
} from "../src/profiles.js";

const OAL = `var OAL_DATA = { _WS: { oalName: "WestJet", iata: "WS", zedY: { employee: "ZM" }, }, }`;

describe("profiles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zed-"));
    process.env.ZED_SETTINGS = join(dir, "settings.json");
  });
  afterEach(() => {
    delete process.env.ZED_SETTINGS;
  });

  it("uses the built-in Air Canada profile until told otherwise", async () => {
    expect(await activeProfileName()).toBe("ac");
    const p = await loadActiveProfile();
    expect(p.home).toEqual(BUILTIN_HOME);
    expect(p.airlines.length).toBeGreaterThan(100);
  });

  it("imports a file as data, switches to it and removes it", async () => {
    const file = join(dir, "westjet-oal.js");
    await writeFile(file, OAL);
    await importProfile(file, "Jane", ["ws"]);
    expect(await listProfiles()).toEqual(["ac", "jane"]);
    expect(await activeProfileName()).toBe("ac"); // importing doesn't switch

    await useProfile("jane");
    const p = await loadActiveProfile();
    expect(p).toMatchObject({ name: "jane", home: ["WS"], airlines: [{ code: "WS", economy: { employee: "ZM" } }] });
    // Stored as parsed JSON, not as the original script.
    expect(JSON.parse(await readFile(join(dir, "oal", "jane.json"), "utf8")).name).toBe("jane");

    await removeProfile("jane");
    expect(await activeProfileName()).toBe("ac");
    expect(await listProfiles()).toEqual(["ac"]);
  });

  it("refuses bad names, the built-in name and unknown profiles", async () => {
    const file = join(dir, "oal.js");
    await writeFile(file, OAL);
    await expect(importProfile(file, "../x", [])).rejects.toThrow(/Profile names/);
    await expect(importProfile(file, "AC", [])).rejects.toThrow(/built-in/);
    await expect(useProfile("nobody")).rejects.toThrow(/No OAL profile called "nobody"/);
    await expect(removeProfile("ac")).rejects.toThrow(/can't be removed/);
    expect(settingsPath()).toBe(join(dir, "settings.json"));
  });

  it("normalises airline codes", () => {
    expect(parseCarrierCodes(["ws, wr", "WS"])).toEqual(["WS", "WR"]);
    expect(() => parseCarrierCodes("WESTJET")).toThrow(/WESTJET/);
  });
});
