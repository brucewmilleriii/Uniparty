import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stub = path.join(__dirname, "fixtures", "votes", "fetch-stub.mjs");

// Runs the real ingest script in --check mode (writes nothing) with fetch stubbed out.
const run = (down: string) =>
  spawnSync("npx", ["tsx", "--import", stub, "scripts/ingest-votes.ts", "--check"], {
    encoding: "utf8",
    env: { ...process.env, STUB_DOWN: down },
  });

describe("ingest-votes script", () => {
  it("keeps the previous Senate votes when senate.gov refuses with 403", () => {
    const r = run("senate.gov");
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("::warning::Senate votes not refreshed");
    expect(r.stdout).toContain("Check passed");
    expect(r.status).toBe(0);
  }, 30_000);

  it("fails when neither chamber can be reached", () => {
    const r = run("senate.gov,clerk.house.gov");
    expect(r.stderr).toContain("Neither chamber could be reached");
    expect(r.status).toBe(1);
  }, 30_000);
});
