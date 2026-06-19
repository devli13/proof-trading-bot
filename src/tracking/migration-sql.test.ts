import { describe, it, expect } from "vitest";
import { migrationSql } from "./postgres.js";

// Guards the security-critical RLS/realtime DDL without needing a live Postgres.
// If anyone weakens these invariants, a test fails.
const sql = migrationSql("proof_bot");

describe("migrationSql — schema", () => {
  it("creates all tables (schema-qualified)", () => {
    for (const tbl of ["bot_orders", "bot_snapshots", "bot_decisions", "bots", "bot_changes"]) {
      expect(sql).toContain(`create table if not exists proof_bot.${tbl}`);
    }
  });
  it("bots stores the encrypted key column", () => {
    expect(sql).toContain("private_key_enc text not null");
  });
});

describe("migrationSql — RLS security invariants", () => {
  it("enables RLS on every table", () => {
    for (const tbl of ["bot_snapshots", "bot_orders", "bot_decisions", "bots", "bot_changes"]) {
      expect(sql).toContain(`alter table %I.${tbl} enable row level security`);
    }
  });
  it("grants anon SELECT on the non-sensitive tables only", () => {
    for (const tbl of ["bot_snapshots", "bot_orders", "bot_decisions", "bot_changes"]) {
      expect(sql).toContain(`grant select on %I.${tbl} to anon`);
    }
  });
  it("NEVER grants anon access to the keys table — and revokes it", () => {
    expect(sql).not.toContain("grant select on %I.bots to anon");
    expect(sql).toContain("revoke all on %I.bots from anon");
  });
  it("anon read policies exist on the non-sensitive tables", () => {
    for (const tbl of ["bot_snapshots", "bot_orders", "bot_decisions", "bot_changes"]) {
      expect(sql).toContain(`create policy anon_read on %I.${tbl} for select to anon using (true)`);
    }
  });
});

describe("migrationSql — realtime invariants", () => {
  it("adds the non-sensitive data tables to the realtime publication", () => {
    for (const tbl of ["bot_snapshots", "bot_orders", "bot_decisions", "bot_changes"]) {
      expect(sql).toContain(`add table %I.${tbl}`);
    }
  });
  it("NEVER publishes the keys table to realtime", () => {
    expect(sql).not.toContain("add table %I.bots");
  });
  it("trigger function pins search_path, revokes public EXECUTE, and is non-Supabase-safe", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("revoke execute on function proof_bot.notify_realtime() from public");
    expect(sql).toContain("when undefined_function then"); // no-op on plain Postgres
    expect(sql).toContain("rolname = 'anon'"); // RLS block guarded by the anon role existing
  });
});
