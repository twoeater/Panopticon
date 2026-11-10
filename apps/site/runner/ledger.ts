import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
export class Ledger {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY,sender TEXT,created INTEGER); CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY,requestId TEXT,automatic INTEGER,created INTEGER,status TEXT,payload TEXT);",
    );
  }
  reserve(
    jobId: string,
    requestId: string,
    sender: string,
    ownerId: string,
    automatic: boolean,
    limits: Config["limits"],
    time = Date.now(),
  ): { allowed: boolean; reason?: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const count = (sql: string, ...args: any[]) =>
        Number((this.db.prepare(sql).get(...args) as any)?.n || 0);
      if (this.db.prepare("SELECT id FROM turns WHERE id=?").get(jobId)) {
        this.db.exec("ROLLBACK");
        return { allowed: false, reason: "이미 수신한 작업입니다." };
      }
      const check = (value: number, limit: number) =>
        limit >= 0 && value >= limit;
      if (
        automatic &&
        check(
          count(
            "SELECT count(*) n FROM turns WHERE automatic=1 AND created>?",
            time - 3600000,
          ),
          limits.automaticTurnsPerHour,
        )
      ) {
        this.db.exec("ROLLBACK");
        return { allowed: false, reason: "자동 대화 한도" };
      }
      if (
        check(
          count("SELECT count(*) n FROM turns WHERE requestId=?", requestId),
          limits.maxTurnsPerRequest,
        )
      ) {
        this.db.exec("ROLLBACK");
        return { allowed: false, reason: "요청 내부 턴 한도" };
      }
      if (
        !automatic &&
        !this.db.prepare("SELECT id FROM requests WHERE id=?").get(requestId)
      ) {
        const since = time - limits.windowMinutes * 60000,
          limit =
            Object.hasOwn(limits.perUser, sender) ? limits.perUser[sender] :
            (sender === ownerId ? limits.self : limits.other);
        if (
          check(
            count(
              "SELECT count(*) n FROM requests WHERE sender=? AND created>?",
              sender,
              since,
            ),
            limit,
          ) ||
          check(
            count("SELECT count(*) n FROM requests WHERE created>?", since),
            limits.total,
          )
        ) {
          this.db.exec("ROLLBACK");
          return { allowed: false, reason: "질문 한도" };
        }
        this.db
          .prepare("INSERT INTO requests VALUES (?,?,?)")
          .run(requestId, sender, time);
      }
      this.db
        .prepare("INSERT INTO turns VALUES (?,?,?,?,'running',NULL)")
        .run(jobId, requestId, Number(automatic), time);
      this.db.exec("COMMIT");
      return { allowed: true };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  chargeCall(
    requestId: string,
    automatic: boolean,
    limits: Config["limits"],
    time = Date.now(),
  ) {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS calls (requestId TEXT,automatic INTEGER,created INTEGER)",
    );
    const count = Number(
      (
        this.db
          .prepare("SELECT count(*) n FROM calls WHERE requestId=?")
          .get(requestId) as any
      ).n,
    );
    const auto = Number(
      (
        this.db
          .prepare(
            "SELECT count(*) n FROM calls WHERE automatic=1 AND created>?",
          )
          .get(time - 3600000) as any
      ).n,
    );
    if (
      count >= limits.maxTurnsPerRequest ||
      (automatic &&
        limits.automaticTurnsPerHour >= 0 &&
        auto >= limits.automaticTurnsPerHour)
    )
      return false;
    this.db
      .prepare("INSERT INTO calls VALUES (?,?,?)")
      .run(requestId, Number(automatic), time);
    return true;
  }
  finish(jobId: string, payload: unknown) {
    this.db
      .prepare("UPDATE turns SET status='finished',payload=? WHERE id=?")
      .run(JSON.stringify(payload), jobId);
  }
  skip(jobId: string, payload: unknown) {
    // Uncharged jobs still need a durable acknowledgement. A null request ID
    // and zero timestamp keep these records out of usage-window counters.
    this.db.prepare("INSERT OR IGNORE INTO turns VALUES (?,NULL,0,0,'finished',?)")
      .run(jobId, JSON.stringify(payload));
  }
  acknowledged(jobId: string) {
    this.db
      .prepare("UPDATE turns SET status='acknowledged' WHERE id=?")
      .run(jobId);
  }
  pending() {
    return this.db
      .prepare(
        "SELECT id,status,payload FROM turns WHERE status IN ('running','finished')",
      )
      .all() as unknown as {
      id: string;
      status: string;
      payload: string | null;
    }[];
  }
  close() {
    this.db.close();
  }
}
