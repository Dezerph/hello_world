import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWhitelist, parseCarrierCodes, saveWhitelist } from "../src/whitelist.js";

describe("whitelist", () => {
  it("normalises codes", () => {
    expect(parseCarrierCodes(["ac, lh", "UA ac", "3k"])).toEqual(["3K", "AC", "LH", "UA"]);
  });

  it("rejects invalid codes", () => {
    expect(() => parseCarrierCodes("AC,AIRCANADA")).toThrow(/AIRCANADA/);
  });

  it("saves and loads, and is empty when nothing is saved", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "zed-")), "settings.json");
    expect(await loadWhitelist(path)).toEqual([]);
    await saveWhitelist(["lh", "AC"], path);
    expect(await loadWhitelist(path)).toEqual(["AC", "LH"]);
  });
});
