import { expect, test } from "bun:test";
import { REQUIRED_ENV } from "./config";

test("exits non-zero and names every missing variable when config is absent", async () => {
  // --no-env-file keeps a developer's local .env from satisfying the config.
  const proc = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/index.ts`], {
    env: { PATH: process.env.PATH },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await proc.exited).toBe(1);
  const stderr = await new Response(proc.stderr).text();
  for (const name of REQUIRED_ENV) {
    expect(stderr).toContain(`${name} is required`);
  }
});

test("shuts down cleanly on SIGTERM", async () => {
  // A complete config with stand-in values. The database is unreachable on
  // purpose: the startup purge only logs its failure, and shutdown must not
  // hang on it either.
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString("base64");
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  const proc = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/index.ts`], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DATABASE_URL: "postgres://turnip:turnip@127.0.0.1:1/turnip?sslmode=disable",
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "access-key",
      R2_SECRET_ACCESS_KEY: "secret-key",
      R2_BUCKET: "turnip",
      APP_BUNDLE_ID: "kim.hoie.turnip",
      APPLE_TEAM_ID: "TEAM123456",
      APPLE_KEY_ID: "KEY1234567",
      APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
      APPLE_REFRESH_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
      TURNIP_PIPELINE_KEY: "pipeline-key",
      INGEST_POLL_INTERVAL_MS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Wait until it serves, then signal it.
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      if (!up) await Bun.sleep(50);
    }
    expect(up).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(proc.signalCode).toBeNull();
    expect(await new Response(proc.stdout).text()).toContain("turnip-farm shutting down");
  } finally {
    proc.kill("SIGKILL");
  }
}, 10_000);
