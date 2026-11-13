// Public community stats (BACKEND_DESIGN.md §7.3).
// GET /api/stats — aggregate-only totals and daily series for the public
// site's stats section: user signups and labeling contributions over the
// last 90 UTC days. Public: no session (§7.1, §1.2.19); the per-IP rate
// limit is applied in startServer's fetch wrapper next to the other
// public endpoints. Served with Cache-Control: max-age=60 and no ETag —
// the payload has no single version to hash, and counts move slowly.
//
// Aggregate-only by construction: the queries count rows and bucket by
// day. They never join source_attribution or any other per-account link,
// so no response can tie a contribution to an account (§1, §1.2.17).
// Counts include every row, quarantined or not: this is community
// activity, not the training set, so §6's quarantine exclusion does not
// apply.
//
// Small counts are not published exactly (§1.2.26): every count, totals
// included, is rounded down to a multiple of STATS_COUNT_STEP, so a day
// with 1–4 signups or labels reads 0 and nobody can tell from the series,
// or from the totals moving, when one person signed up or labeled.

import type { SQL } from "bun";

export interface StatsDeps {
  sql: SQL;
}

export interface DayCount {
  date: string;
  count: number;
}

export interface StatsBody {
  totals: { users: number; sources: number; clips: number; labels: number };
  users_by_day: DayCount[];
  labels_by_day: DayCount[];
}

/** Days in each series, including today. */
const WINDOW_DAYS = 90;

/** Published counts are rounded down to a multiple of this (judgment call). */
export const STATS_COUNT_STEP = 5;

/** Rounds a count down to a multiple of STATS_COUNT_STEP, so 1–4 reads 0. */
export function coarsen(count: number): number {
  return Math.floor(count / STATS_COUNT_STEP) * STATS_COUNT_STEP;
}

// One row per UTC day for the window, including days with no rows — the
// series is continuous so the frontend draws one bar per day. Bucketing
// is UTC-explicit: (created_at AT TIME ZONE 'UTC')::date, so the series
// is identical regardless of the session timezone. The two queries are
// written out literally (the table name is never interpolated) following
// the models/taxonomy handlers' explicit style.
async function dailySeries(sql: SQL, table: "users" | "labels"): Promise<DayCount[]> {
  const span = WINDOW_DAYS - 1;
  const rows =
    table === "users"
      ? ((await sql`
          WITH bounds AS (
            SELECT (now() AT TIME ZONE 'UTC')::date - INTERVAL '1 day' * ${span} AS d0
          ),
          days AS (
            SELECT generate_series(d0, d0 + INTERVAL '1 day' * ${span}, INTERVAL '1 day')::date AS day
            FROM bounds
          )
          SELECT to_char(days.day, 'YYYY-MM-DD') AS date, COUNT(u.id)::int AS count
          FROM days
          LEFT JOIN users u ON (u.created_at AT TIME ZONE 'UTC')::date = days.day
          GROUP BY days.day
          ORDER BY days.day ASC`) as { date: string; count: number }[])
      : ((await sql`
          WITH bounds AS (
            SELECT (now() AT TIME ZONE 'UTC')::date - INTERVAL '1 day' * ${span} AS d0
          ),
          days AS (
            SELECT generate_series(d0, d0 + INTERVAL '1 day' * ${span}, INTERVAL '1 day')::date AS day
            FROM bounds
          )
          SELECT to_char(days.day, 'YYYY-MM-DD') AS date, COUNT(l.id)::int AS count
          FROM days
          LEFT JOIN labels l ON (l.created_at AT TIME ZONE 'UTC')::date = days.day
          GROUP BY days.day
          ORDER BY days.day ASC`) as { date: string; count: number }[]);
  return rows.map((r) => ({ date: r.date, count: coarsen(Number(r.count)) }));
}

// GET /api/stats — the community totals and daily series. Always 200: an
// empty farm reports zeros and ninety zero days, not an error.
export async function handleGetStats(_req: Request, deps: StatsDeps): Promise<Response> {
  const [totalsRows] = await deps.sql`
    SELECT (SELECT COUNT(*)::int FROM users) AS users,
           (SELECT COUNT(*)::int FROM sources) AS sources,
           (SELECT COUNT(*)::int FROM clips) AS clips,
           (SELECT COUNT(*)::int FROM labels) AS labels`;
  const totals = totalsRows as unknown as Record<string, number>;
  const usersByDay = await dailySeries(deps.sql, "users");
  const labelsByDay = await dailySeries(deps.sql, "labels");
  const body: StatsBody = {
    totals: {
      users: coarsen(Number(totals.users)),
      sources: coarsen(Number(totals.sources)),
      clips: coarsen(Number(totals.clips)),
      labels: coarsen(Number(totals.labels)),
    },
    users_by_day: usersByDay,
    labels_by_day: labelsByDay,
  };
  return Response.json(body, { headers: { "Cache-Control": "max-age=60" } });
}
