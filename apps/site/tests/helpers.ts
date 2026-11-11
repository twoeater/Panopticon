import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { Database } from "../lib/domain.ts";
export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, values: any[] = []): any => ({
    bind: (...args: any[]) => statement(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({ meta: sqlite.prepare(sql).run(...values) }),
    execute: () => ({ meta: sqlite.prepare(sql).run(...values) }),
  });
  const db: Database = {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push((s as any).execute());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { sqlite, db };
}
