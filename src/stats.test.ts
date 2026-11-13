// Public community stats (BACKEND_DESIGN.md §7.3).
// The handler is tested with a stub sql, plus a DB-backed round trip
// (rolled back per db/testing.ts) that runs only when TEST_DATABASE_URL
// names a database.

import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { STATS_COUNT_STEP, coarsen, handleGetStats, type DayCount } from "./stats";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : null;
afterAll(async () => {
  await sharedSql?.end();
});

// Dispatching stub: the totals query has no generate_series; each series
// query joins its own table.
const stubSql = (
  totals: Record<string, number>,
  usersSeries: DayCount[],
  labelsSeries: DayCount[],
) =>
  (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("generate_series")) {
      if (text.includes("JOIN users")) return usersSeries;
      if (text.includes("JOIN labels")) return labelsSeries;
    }
    return [totals];
  }) as unknown as SQL;

const get = () => new Request("http://farm.test/api/stats", { method: "GET" });

describe("handleGetStats", () => {
  test("200 with coarsened totals, both series, and Cache-Control", async () => {
    const usersSeries = [
      { date: "2026-10-28", count: 1 },
      { date: "2026-10-29", count: 12 },
    ];
    const labelsSeries = [
      { date: "2026-10-28", count: 0 },
      { date: "2026-10-29", count: 5 },
    ];
    const sql = stubSql(
      { users: 13, sources: 2, clips: 24, labels: 17 },
      usersSeries,
      labelsSeries,
    );
    const res = await handleGetStats(get(), { sql });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("max-age=60");
    const body = (await res.json()) as {
      totals: Record<string, number>;
      users_by_day: DayCount[];
      labels_by_day: DayCount[];
    };
    expect(body.totals).toEqual({ users: 10, sources: 0, clips: 20, labels: 15 });
    expect(body.users_by_day).toEqual([
      { date: "2026-10-28", count: 0 },
      { date: "2026-10-29", count: 10 },
    ]);
    expect(body.labels_by_day).toEqual(labelsSeries);
  });

  test("counts are numbers in the body", async () => {
    const sql = stubSql(
      { users: 1, sources: 0, clips: 0, labels: 0 },
      [{ date: "2026-10-29", count: 1 }],
      [{ date: "2026-10-29", count: 0 }],
    );
    const res = await handleGetStats(get(), { sql });
    const body = (await res.json()) as {
      totals: Record<string, number>;
      users_by_day: DayCount[];
      labels_by_day: DayCount[];
    };
    expect(typeof body.totals.users).toBe("number");
    expect(typeof body.users_by_day[0]?.count).toBe("number");
  });
});

describeDb("handleGetStats, DB-backed", () => {
  test("totals count every row; series bucket by UTC day over 90 days", async () => {
    const sql = new SQL(TEST_DATABASE_URL ?? "");
    try {
      await inRollback(sql, async (tx) => {
        // UTC day boundaries: 23:30 UTC yesterday and 00:30 UTC today must
        // land in different buckets, and a row 100 days back must count in
        // the totals but in no bucket.
        const todayMidnight = new Date();
        todayMidnight.setUTCHours(0, 0, 0, 0);
        const t = (ms: number) => new Date(todayMidnight.getTime() + ms).toISOString();
        const yesterdayLate = t(-30 * 60 * 1000);
        const todayEarly = t(30 * 60 * 1000);
        const old = t(-100 * 24 * 3600 * 1000);
        const todayDate = todayMidnight.toISOString().slice(0, 10);
        const yesterdayDate = new Date(todayMidnight.getTime() - 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);

        const twoDaysAgo = t(-36 * 3600 * 1000);
        const twoDaysAgoDate = new Date(todayMidnight.getTime() - 2 * 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);

        // Raw counts, and what STATS_COUNT_STEP = 5 publishes:
        // users: 5 today → 5, 6 yesterday → 5, 2 two days ago → 0, 1 old; total 14 → 10.
        const users: [string, string][] = [
          ...Array.from({ length: 5 }, (_, i): [string, string] => [`u-today-${i}`, todayEarly]),
          ...Array.from({ length: 6 }, (_, i): [string, string] => [`u-yesterday-${i}`, yesterdayLate]),
          ...Array.from({ length: 2 }, (_, i): [string, string] => [`u-two-${i}`, twoDaysAgo]),
          ["u-old", old],
        ];
        for (const [id, at] of users) {
          await tx`INSERT INTO users (id, created_at) VALUES (${id}, ${at}::timestamptz)`;
        }
        const vid = (ch: string) => ch.repeat(64);
        await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key, created_at)
          VALUES (${vid("a")}, ${vid("b")}, 100, 30, 'poses/x.tkp1.gz', ${todayEarly}::timestamptz)`;
        // labels: 6 today → 5, 4 yesterday → 0, 1 old; total 11 → 10. Clips: 7 → 5.
        for (let i = 1; i <= 7; i++) {
          const clip = `123e4567-e89b-42d3-a456-42661417400${i}`;
          await tx`INSERT INTO clips (id, source_id, start_frame, end_frame, created_at)
            VALUES (${clip}::uuid, ${vid("a")}, 0, 10, ${todayEarly}::timestamptz)`;
          if (i <= 6) {
            await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version, origin, created_at)
              VALUES (${clip}::uuid, 'cork', 1, 'typed', ${todayEarly}::timestamptz)`;
          }
          if (i <= 4) {
            await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version, origin, created_at)
              VALUES (${clip}::uuid, 'gainer', 1, 'typed', ${yesterdayLate}::timestamptz)`;
          }
          if (i === 1) {
            await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version, origin, created_at)
              VALUES (${clip}::uuid, 'hook', 1, 'typed', ${old}::timestamptz)`;
          }
        }

        const res = await handleGetStats(get(), { sql: tx as unknown as SQL });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          totals: Record<string, number>;
          users_by_day: DayCount[];
          labels_by_day: DayCount[];
        };
        expect(body.totals).toEqual({ users: 10, sources: 0, clips: 5, labels: 10 });

        for (const series of [body.users_by_day, body.labels_by_day]) {
          expect(series).toHaveLength(90);
          const first = series[0];
          const last = series[series.length - 1];
          if (!first || !last) throw new Error("series is empty");
          expect(first.date).toBe(
            new Date(todayMidnight.getTime() - 89 * 24 * 3600 * 1000).toISOString().slice(0, 10),
          );
          expect(last.date).toBe(todayDate);
          const dates = series.map((d) => d.date);
          expect([...dates].sort()).toEqual(dates);
          expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
          // No published count is off the 5-step grid.
          expect(series.every((d) => d.count % 5 === 0)).toBe(true);
        }
        const usersByDate = Object.fromEntries(body.users_by_day.map((d) => [d.date, d.count]));
        const labelsByDate = Object.fromEntries(body.labels_by_day.map((d) => [d.date, d.count]));
        expect(usersByDate[todayDate]).toBe(5);
        expect(usersByDate[yesterdayDate]).toBe(5);
        // A day with 1–4 is not exposed exactly.
        expect(usersByDate[twoDaysAgoDate]).toBe(0);
        expect(labelsByDate[todayDate]).toBe(5);
        expect(labelsByDate[yesterdayDate]).toBe(0);
        expect(body.users_by_day.reduce((s, d) => s + d.count, 0)).toBe(10);
        expect(body.labels_by_day.reduce((s, d) => s + d.count, 0)).toBe(5);
      });
    } finally {
      await sql.end();
    }
  });
});

describe("coarsen", () => {
  test("rounds down to a multiple of STATS_COUNT_STEP, so 1–4 reads 0", () => {
    expect(STATS_COUNT_STEP).toBe(5);
    expect([0, 1, 2, 3, 4, 5, 9, 10, 14, 1234].map(coarsen)).toEqual([0, 0, 0, 0, 0, 5, 5, 10, 10, 1230]);
  });
});
