#!/usr/bin/env node

/**
 * Dumps the Supabase database, encrypts the dump, and uploads it to Cloudflare R2.
 *
 * Three decisions in here are not obvious, so they are written down:
 *
 *   1. `supabase db dump` instead of a bare `pg_dump`. GitHub's ubuntu-latest image
 *      ships postgresql-client 16 while the database is Postgres 17, and pg_dump
 *      refuses to dump a newer server. The Supabase CLI runs pg_dump inside a
 *      version-matched container, so the mismatch disappears. Its three-file output
 *      (roles, schema, data) is also the restore path Supabase supports.
 *   2. The AWS CLI instead of rclone. apps/workers/tiles/scripts/upload-tiles.sh uses
 *      rclone because it streams a 120 GB remote URL straight into R2. The AWS CLI is
 *      preinstalled on ubuntu-latest and needs no install step for a file this small.
 *   3. Row counts are parsed out of the COPY blocks in data.sql rather than queried.
 *      That keeps the job free of a psql dependency, and it counts what actually
 *      reached the dump instead of what was in the database a moment earlier.
 *
 * The worst failure mode is an empty dump that uploads cleanly and is discovered
 * months later. assertDumpFiles and assertDataDump exist to make that loud.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDirectory, "..", "..");

/**
 * The endpoint and bucket arrive as repository variables, not as source. Neither is a
 * credential, and both are readable by anyone holding the R2 token anyway. Keeping
 * them out of the tree simply avoids publishing the account id in a public history,
 * where it would help someone aim at the right target.
 */
export function buildEndpoint(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/** The manifest key. Rewritten every run, so no bucket lock may cover it. */
export const MANIFEST_KEY = "latest.json";

/**
 * A dump missing this table is not a Ubikas backup. Checked so that a dump which
 * succeeds against the wrong database, or against an empty one, fails here.
 */
export const REQUIRED_TABLE = "places";

/** Fewer COPY blocks than this means the dump captured a fraction of the schema. */
export const MINIMUM_TABLE_COUNT = 5;

function fail(message) {
  throw new Error(message);
}

/**
 * Removes the connection string, and anything that looks like one, from text that is
 * about to be printed. Log output in this repository is world-readable.
 *
 * This replaced a blanket redaction that printed nothing at all on failure. That was
 * safe and useless: the first real run failed with "supabase exited 1" and no reason,
 * which is the wrong trade for a job nobody watches.
 */
/**
 * Checks the shape of the connection string before anything expensive runs.
 *
 * The Supabase CLI answers a bad value with "failed to parse as DSN (invalid dsn)",
 * which names nothing and arrives two minutes in, after Docker has started. Every
 * message here says which part is wrong without ever echoing the value: this runs in
 * a repository whose logs anyone can read.
 */
export function assertDatabaseUrl(databaseUrl) {
  const problem = describeDatabaseUrlProblem(databaseUrl);
  if (problem) fail(`SUPABASE_DB_URL ${problem}`);
  return databaseUrl;
}

export function describeDatabaseUrlProblem(databaseUrl) {
  if (databaseUrl !== databaseUrl.trim()) {
    return "has leading or trailing whitespace. Re-set the secret without it.";
  }
  if (/\s/.test(databaseUrl)) {
    return "contains a space or newline. Re-set the secret as a single line.";
  }
  if (databaseUrl.startsWith("https://") || databaseUrl.startsWith("http://")) {
    return (
      "looks like the project API URL, not a database connection string. " +
      "Take the Postgres URI from Project Settings, Database, Connection string."
    );
  }
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    return 'must start with "postgresql://".';
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    return (
      "could not be parsed. If the password contains any of @ : / ? # % or a space, " +
      "percent-encode it."
    );
  }

  if (!url.hostname) return "names no host.";
  if (!url.username) return "carries no user.";
  if (!url.password) {
    return (
      "carries no password. The value copied from the dashboard holds a " +
      "[YOUR-PASSWORD] placeholder; replace it with the real password."
    );
  }
  // new URL() percent-encodes the brackets, so the raw value is what to test.
  if (/\[|%5B|YOUR-PASSWORD/i.test(databaseUrl)) {
    return "still holds the [YOUR-PASSWORD] placeholder instead of the real password.";
  }
  if (/^db\..+\.supabase\.(co|com)$/i.test(url.hostname)) {
    return (
      "uses the direct database host, which resolves to IPv6 only unless the project " +
      "buys the IPv4 add-on. A GitHub-hosted runner cannot reach it. Use the session " +
      "pooler host, which answers on IPv4, on port 5432."
    );
  }
  if (url.port === "6543") {
    return (
      "uses port 6543, which is transaction pooling mode. pg_dump is not supported " +
      "there. Use the session pooler on port 5432."
    );
  }

  return null;
}

/**
 * Finds the Supabase project ref, which hides in two different places depending on
 * which connection string was used: the pooler puts it in the username as
 * `postgres.<ref>`, the direct connection puts it in the host as `db.<ref>.supabase.co`.
 *
 * Keeping the host in error output is what makes a failure diagnosable. This is what
 * stops that decision from publishing the ref along with it.
 */
export function supabaseProjectRef(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    const fromUser = url.username.match(/^postgres\.([a-z0-9]{8,})$/i);
    if (fromUser) return fromUser[1];
    const fromHost = url.hostname.match(/^db\.([a-z0-9]{8,})\.supabase\.(?:co|com)$/i);
    if (fromHost) return fromHost[1];
  } catch {
    // Not parseable, so there is no ref to find.
  }
  return null;
}

export function scrubConnectionString(text, databaseUrl) {
  let scrubbed = text;

  if (databaseUrl) {
    scrubbed = scrubbed.split(databaseUrl).join("<db-url>");
    try {
      const url = new URL(databaseUrl);
      // The password is the secret. The username carries the Supabase project ref.
      // The host is neither, and "no such host" is the most useful line in a failure,
      // so it stays. The length guard stops a short value from mangling normal text:
      // scrubbing every "d" out of a log helps nobody.
      const ref = supabaseProjectRef(databaseUrl);
      // "postgres" on its own is generic and appears in image names and error text.
      // Scrubbing it turned ghcr.io/supabase/postgres into ghcr.io/supabase/<redacted>.
      const username = url.username === "postgres" ? null : url.username;
      for (const secret of [url.password, decodeURIComponent(url.password), username, ref]) {
        if (secret && secret.length >= 4) scrubbed = scrubbed.split(secret).join("<redacted>");
      }
    } catch {
      // An unparseable value is still removed by the literal replacement above.
    }
  }

  // Catches a connection string the CLI composed itself, in any spelling.
  return scrubbed.replace(/postgres(?:ql)?:\/\/\S+/gi, "<db-url>");
}

function run(command, args, options = {}) {
  const { scrub, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...spawnOptions,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const output = scrub ? scrub(raw) : raw;
    fail(`${command} exited ${result.status}${output ? `:\n${output}` : ""}`);
  }
  return result.stdout ?? "";
}

export function parseBackupArgs(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  let dryRun = false;
  let allowEmpty = false;
  let bucket = null;

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];

    if (argument === "--dry-run") {
      if (dryRun) fail("backup accepts --dry-run at most once");
      dryRun = true;
      continue;
    }

    if (argument === "--allow-empty") {
      if (allowEmpty) fail("backup accepts --allow-empty at most once");
      allowEmpty = true;
      continue;
    }

    if (argument === "--bucket") {
      if (bucket !== null) fail("backup accepts at most one --bucket <name>");
      bucket = normalized[index + 1];
      if (!bucket || bucket.startsWith("--")) fail("backup requires a value after --bucket");
      index += 1;
      continue;
    }

    fail(`backup received an unexpected argument: ${argument}`);
  }

  return { dryRun, allowEmpty, bucket };
}

/**
 * Reads configuration from the environment and names every missing value at once.
 * Reporting them one at a time turns a first run into four failed runs.
 */
export function resolveConfig(env, { dryRun, bucket }) {
  const missing = [];
  const required = ["SUPABASE_DB_URL", "BACKUP_AGE_RECIPIENT", "R2_ACCOUNT_ID"];
  if (!bucket && !env.R2_BUCKET) required.push("R2_BUCKET");
  if (!dryRun) required.push("R2_BACKUP_ACCESS_KEY_ID", "R2_BACKUP_SECRET_ACCESS_KEY");

  for (const name of required) {
    if (!env[name] || !env[name].trim()) missing.push(name);
  }

  if (missing.length > 0) {
    fail(
      [
        `Missing required environment ${missing.length === 1 ? "variable" : "variables"}: ${missing.join(", ")}.`,
        "",
        "In GitHub Actions these come from repository secrets and variables. See README.md.",
        "",
        "Locally, against a database you do not mind reading:",
        "",
        '  SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \\',
        '  BACKUP_AGE_RECIPIENT="age1..." \\',
        '  R2_ACCOUNT_ID="..." R2_BUCKET="..." \\',
        "  node scripts/backup.mjs --dry-run",
      ].join("\n"),
    );
  }

  const recipient = env.BACKUP_AGE_RECIPIENT.trim();
  if (!recipient.startsWith("age1")) {
    fail(`BACKUP_AGE_RECIPIENT must be an age public key starting with "age1"`);
  }

  return {
    databaseUrl: assertDatabaseUrl(env.SUPABASE_DB_URL.trim()),
    recipient,
    bucket: (bucket ?? env.R2_BUCKET ?? "").trim(),
    endpoint: buildEndpoint(env.R2_ACCOUNT_ID.trim()),
    accessKeyId: env.R2_BACKUP_ACCESS_KEY_ID?.trim() ?? "",
    secretAccessKey: env.R2_BACKUP_SECRET_ACCESS_KEY?.trim() ?? "",
  };
}

/** `2026-08-21T03:00:00.000Z` becomes `20260821T030000Z`. */
export function buildTimestamp(date) {
  return `${date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")}Z`;
}

/**
 * Dates the object by prefix as well as by name. The year and month prefixes keep
 * the bucket listable by hand, and the `daily/` prefix is what the lifecycle rule
 * and the bucket lock both target.
 */
export function buildObjectKey(date) {
  const year = date.toISOString().slice(0, 4);
  const month = date.toISOString().slice(5, 7);
  return `daily/${year}/${month}/ubikas-${buildTimestamp(date)}.tar.gz.age`;
}

/**
 * Counts the rows in every COPY block of a `--data-only --use-copy` dump. The block
 * runs from `COPY "public"."table" (...) FROM stdin;` to a line holding only `\.`.
 */
export function parseCopyRowCounts(sql) {
  const counts = {};
  let currentTable = null;
  let currentCount = 0;

  for (const line of sql.split("\n")) {
    if (currentTable === null) {
      const header = line.match(/^COPY\s+"?public"?\."?([A-Za-z0-9_]+)"?\s*\(/);
      if (header) {
        currentTable = header[1];
        currentCount = 0;
      }
      continue;
    }

    if (line === "\\.") {
      counts[currentTable] = (counts[currentTable] ?? 0) + currentCount;
      currentTable = null;
      continue;
    }

    currentCount += 1;
  }

  if (currentTable !== null) {
    fail(`data.sql ends inside the COPY block for "${currentTable}"; the dump is truncated`);
  }

  return counts;
}

export function assertDumpFiles(sizes) {
  for (const [name, size] of Object.entries(sizes)) {
    if (size <= 0) fail(`${name} is empty; refusing to upload an incomplete backup`);
  }
  return sizes;
}

export function assertDataDump(rowCounts, { allowEmpty = false } = {}) {
  const tables = Object.keys(rowCounts);

  if (tables.length === 0) {
    fail("data.sql contains no COPY blocks; the dump captured no data at all");
  }

  if (allowEmpty) return rowCounts;

  if (tables.length < MINIMUM_TABLE_COUNT) {
    fail(
      `data.sql covers only ${tables.length} table(s), fewer than the expected ${MINIMUM_TABLE_COUNT}. ` +
        "Pass --allow-empty if this is genuinely correct.",
    );
  }

  if (!rowCounts[REQUIRED_TABLE]) {
    fail(
      `data.sql holds no rows for "${REQUIRED_TABLE}". This is probably the wrong database. ` +
        "Pass --allow-empty if this is genuinely correct.",
    );
  }

  return rowCounts;
}

export function buildManifest({ objectKey, bytes, sha256, rowCounts, startedAt, finishedAt }) {
  return {
    object_key: objectKey,
    checksum_key: `${objectKey}.sha256`,
    bytes,
    sha256,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    total_rows: Object.values(rowCounts).reduce((total, count) => total + count, 0),
    row_counts: rowCounts,
  };
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Prefers a globally installed CLI, which is what supabase/setup-cli provides in CI,
 * and falls back to the workspace copy pinned in packages/backend.
 */
export function supabaseCommand({ hasGlobalCli }) {
  return hasGlobalCli
    ? { command: "supabase", prefix: [] }
    : { command: "pnpm", prefix: ["--filter", "@ubikas/backend", "exec", "supabase"] };
}

function hasGlobalSupabaseCli() {
  const probe = spawnSync("supabase", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

export const BINARY_INSTALL_HINTS = {
  age: "macOS: brew install age. Ubuntu: sudo apt-get install -y age.",
  tar: "tar ships with macOS and every Ubuntu image. A missing tar means a broken PATH.",
  aws: "macOS: brew install awscli. It is preinstalled on GitHub's ubuntu-latest runners.",
};

/**
 * Checks for every external binary up front. Without this the job dumps the whole
 * database, then dies on `spawnSync age ENOENT` with no hint about what to install.
 */
export function requiredBinaries({ dryRun }) {
  return dryRun ? ["age", "tar"] : ["age", "tar", "aws"];
}

function assertRequiredBinaries(options, { probe = isExecutable } = {}) {
  const missing = requiredBinaries(options).filter((binary) => !probe(binary));
  if (missing.length === 0) return;

  fail(
    [
      `Missing required ${missing.length === 1 ? "binary" : "binaries"}: ${missing.join(", ")}.`,
      "",
      ...missing.map((binary) => `  ${binary} — ${BINARY_INSTALL_HINTS[binary]}`),
      "",
      "See docs/database-backups.md.",
    ].join("\n"),
  );
}

function isExecutable(binary) {
  const probe = spawnSync(binary, ["--version"], { stdio: "ignore" });
  return !probe.error;
}

function dumpDatabase(cli, databaseUrl, outputPath, extraArgs) {
  run(
    cli.command,
    [...cli.prefix, "db", "dump", "--db-url", databaseUrl, "--file", outputPath, ...extraArgs],
    { scrub: (text) => scrubConnectionString(text, databaseUrl) },
  );
}

function uploadObject({ key, body, contentType, config }) {
  run(
    "aws",
    [
      "s3api",
      "put-object",
      "--endpoint-url",
      config.endpoint,
      "--bucket",
      config.bucket,
      "--key",
      key,
      "--body",
      body,
      "--content-type",
      contentType,
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: config.accessKeyId,
        AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
        AWS_DEFAULT_REGION: "auto",
        // R2 rejects the flexible checksum headers that AWS CLI v2 sends by default.
        AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
        AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
      },
    },
  );
}

function main(argv, { now = () => new Date() } = {}) {
  const options = parseBackupArgs(argv);
  const config = resolveConfig(process.env, options);
  const bucket = config.bucket;
  assertRequiredBinaries(options);
  const startedAt = now();
  const workDirectory = mkdtempSync(join(tmpdir(), "ubikas-backup-"));

  try {
    const cli = supabaseCommand({ hasGlobalCli: hasGlobalSupabaseCli() });
    const rolesPath = join(workDirectory, "roles.sql");
    const schemaPath = join(workDirectory, "schema.sql");
    const dataPath = join(workDirectory, "data.sql");

    console.log("Dumping roles...");
    dumpDatabase(cli, config.databaseUrl, rolesPath, ["--role-only"]);
    console.log("Dumping schema...");
    dumpDatabase(cli, config.databaseUrl, schemaPath, []);
    console.log("Dumping data...");
    dumpDatabase(cli, config.databaseUrl, dataPath, ["--data-only", "--use-copy"]);

    assertDumpFiles({
      "roles.sql": statSync(rolesPath).size,
      "schema.sql": statSync(schemaPath).size,
      "data.sql": statSync(dataPath).size,
    });

    const rowCounts = assertDataDump(parseCopyRowCounts(readFileSync(dataPath, "utf8")), options);
    const totalRows = Object.values(rowCounts).reduce((total, count) => total + count, 0);
    console.log(`Dumped ${totalRows} rows across ${Object.keys(rowCounts).length} tables.`);

    const archivePath = join(workDirectory, "backup.tar.gz");
    run("tar", ["-czf", archivePath, "-C", workDirectory, "roles.sql", "schema.sql", "data.sql"]);

    const encryptedPath = `${archivePath}.age`;
    run("age", [
      "--encrypt",
      "--recipient",
      config.recipient,
      "--output",
      encryptedPath,
      archivePath,
    ]);

    const bytes = statSync(encryptedPath).size;
    const sha256 = sha256OfFile(encryptedPath);
    const objectKey = buildObjectKey(startedAt);
    const checksumPath = `${encryptedPath}.sha256`;
    writeFileSync(checksumPath, `${sha256}  ${objectKey.split("/").pop()}\n`);

    const manifest = buildManifest({
      objectKey,
      bytes,
      sha256,
      rowCounts,
      startedAt,
      finishedAt: now(),
    });
    const manifestPath = join(workDirectory, "latest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    if (options.dryRun) {
      console.log(`Dry run. Would upload ${bytes} bytes to ${bucket}/${objectKey}`);
      console.log(readFileSync(manifestPath, "utf8"));
      return;
    }

    console.log(`Uploading ${bytes} bytes to ${bucket}/${objectKey}...`);
    uploadObject({
      key: objectKey,
      body: encryptedPath,
      contentType: "application/octet-stream",
      config,
    });
    uploadObject({
      key: `${objectKey}.sha256`,
      body: checksumPath,
      contentType: "text/plain",
      config,
    });
    uploadObject({
      key: MANIFEST_KEY,
      body: manifestPath,
      contentType: "application/json",
      config,
    });

    console.log(`Backup complete: ${objectKey} (sha256 ${sha256})`);
  } finally {
    // The temp directory holds an unencrypted dump of every user record.
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
