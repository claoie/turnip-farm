// Runs a maintainer CLI against DATABASE_URL (Bun loads .env) and exits
// with its status. Only the database is needed, so this skips loadConfig,
// which requires every R2 and Apple variable.

import { SQL } from "bun";
import type { Output } from "../src/moderation";

export async function runCli(cli: (args: string[], sql: SQL, io: Output) => Promise<number>): Promise<never> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(2);
  }
  const sql = new SQL(url);
  let status: number;
  try {
    status = await cli(process.argv.slice(2), sql, {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } finally {
    await sql.end();
  }
  process.exit(status);
}
