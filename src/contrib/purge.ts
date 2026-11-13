// Retention purge (BACKEND_DESIGN.md §1.2.17, §4), at startup and hourly
// from src/index.ts. Attribution is kept until the account is deleted, by
// the user or after 24 months idle (src/auth/account.ts). The exception is
// an account that never agreed to a disclosure saying so: it was told 30
// days, so its attribution is still deleted 30 days after the source's last
// write. Reports are deleted 30 days after they are filed, reviewed or not.

import type { SQL } from "bun";
import { RETENTION_UNTIL_DELETION_DISCLOSURE } from "../consent";

export async function purgeExpiredAttribution(sql: SQL): Promise<void> {
  await sql`
    DELETE FROM source_attribution a
    WHERE a.attributed_at < now() - interval '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM consents c
        WHERE c.user_id = a.user_id
          AND c.disclosure_version >= ${RETENTION_UNTIL_DELETION_DISCLOSURE}
      )`;
  await sql`DELETE FROM reports WHERE created_at < now() - interval '30 days'`;
}
