import assert from "node:assert/strict";
import test from "node:test";

import {
  BINARY_INSTALL_HINTS,
  MINIMUM_TABLE_COUNT,
  REQUIRED_TABLE,
  buildEndpoint,
  describeDatabaseUrlProblem,
  assertDataDump,
  assertDumpFiles,
  buildManifest,
  buildObjectKey,
  buildTimestamp,
  parseBackupArgs,
  parseCopyRowCounts,
  requiredBinaries,
  resolveConfig,
  scrubConnectionString,
  supabaseProjectRef,
  supabaseCommand,
} from "./backup.mjs";

const VALID_ENV = {
  SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  BACKUP_AGE_RECIPIENT: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsvpnvs",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET: "example-db-backups",
  R2_BACKUP_ACCESS_KEY_ID: "key",
  R2_BACKUP_SECRET_ACCESS_KEY: "secret",
};

function dataDump(blocks) {
  return blocks
    .map(({ table, rows }) => {
      const header = `COPY "public"."${table}" ("id", "name") FROM stdin;`;
      const body = Array.from({ length: rows }, (_, index) => `${index}\trow`).join("\n");
      return rows > 0 ? `${header}\n${body}\n\\.` : `${header}\n\\.`;
    })
    .join("\n\n");
}

function fullDump() {
  return dataDump([
    { table: "institutions", rows: 1 },
    { table: "campuses", rows: 2 },
    { table: "place_categories", rows: 30 },
    { table: "buildings", rows: 12 },
    { table: REQUIRED_TABLE, rows: 400 },
  ]);
}

test("parses the default options and every accepted flag", () => {
  assert.deepEqual(parseBackupArgs([]), {
    dryRun: false,
    allowEmpty: false,
    bucket: null,
  });
  assert.deepEqual(parseBackupArgs(["--dry-run", "--allow-empty", "--bucket", "scratch"]), {
    dryRun: true,
    allowEmpty: true,
    bucket: "scratch",
  });
});

test("tolerates the leading -- that pnpm passes through", () => {
  assert.equal(parseBackupArgs(["--", "--dry-run"]).dryRun, true);
});

test("rejects unknown, repeated, and valueless arguments", () => {
  assert.throws(() => parseBackupArgs(["--upload"]), /unexpected argument: --upload/);
  assert.throws(() => parseBackupArgs(["--dry-run", "--dry-run"]), /at most once/);
  assert.throws(() => parseBackupArgs(["--bucket"]), /requires a value after --bucket/);
  assert.throws(
    () => parseBackupArgs(["--bucket", "--dry-run"]),
    /requires a value after --bucket/,
  );
});

test("names every missing environment variable in one message", () => {
  assert.throws(
    () => resolveConfig({}, { dryRun: false }),
    /SUPABASE_DB_URL, BACKUP_AGE_RECIPIENT, R2_ACCOUNT_ID, R2_BUCKET, R2_BACKUP_ACCESS_KEY_ID, R2_BACKUP_SECRET_ACCESS_KEY/,
  );
});

test("derives the endpoint from the account id instead of hardcoding it", () => {
  assert.equal(
    buildEndpoint("0123456789abcdef0123456789abcdef"),
    "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  );
  assert.equal(resolveConfig(VALID_ENV, {}).endpoint, buildEndpoint(VALID_ENV.R2_ACCOUNT_ID));
});

test("takes the bucket from --bucket first, then the environment", () => {
  assert.equal(resolveConfig(VALID_ENV, {}).bucket, "example-db-backups");
  assert.equal(resolveConfig(VALID_ENV, { bucket: "scratch" }).bucket, "scratch");
  const { R2_BUCKET, ...withoutBucket } = VALID_ENV;
  assert.equal(resolveConfig(withoutBucket, { bucket: "scratch" }).bucket, "scratch");
  assert.throws(() => resolveConfig(withoutBucket, {}), /R2_BUCKET/);
});

test("a dry run needs no R2 credentials", () => {
  const { R2_BACKUP_ACCESS_KEY_ID, R2_BACKUP_SECRET_ACCESS_KEY, ...rest } = VALID_ENV;
  const config = resolveConfig(rest, { dryRun: true });
  assert.equal(config.accessKeyId, "");
  assert.throws(
    () => resolveConfig({ SUPABASE_DB_URL: VALID_ENV.SUPABASE_DB_URL }, { dryRun: true }),
    /BACKUP_AGE_RECIPIENT/,
  );
});

test("rejects a recipient that is not an age public key", () => {
  assert.throws(
    () => resolveConfig({ ...VALID_ENV, BACKUP_AGE_RECIPIENT: "AGE-SECRET-KEY-1ABC" }, {}),
    /must be an age public key/,
  );
});

test("treats whitespace-only values as missing", () => {
  assert.throws(
    () => resolveConfig({ ...VALID_ENV, SUPABASE_DB_URL: "   " }, {}),
    /SUPABASE_DB_URL/,
  );
});

test("builds a sortable timestamp and a prefixed object key", () => {
  const date = new Date("2026-08-21T03:00:00.000Z");
  assert.equal(buildTimestamp(date), "20260821T030000Z");
  assert.equal(buildObjectKey(date), "daily/2026/08/ubikas-20260821T030000Z.tar.gz.age");
});

test("keeps every daily object under the prefix the lifecycle rule targets", () => {
  assert.match(buildObjectKey(new Date("2027-01-02T23:59:59.000Z")), /^daily\/2027\/01\//);
});

test("counts the rows in each COPY block", () => {
  assert.deepEqual(
    parseCopyRowCounts(
      dataDump([
        { table: "places", rows: 3 },
        { table: "users", rows: 0 },
      ]),
    ),
    { places: 3, users: 0 },
  );
});

test("reads COPY headers whether or not the identifiers are quoted", () => {
  const sql = ["COPY public.places (id) FROM stdin;", "1", "2", "\\."].join("\n");
  assert.deepEqual(parseCopyRowCounts(sql), { places: 2 });
});

test("ignores SQL outside COPY blocks", () => {
  const sql = [
    "SET session_replication_role = replica;",
    "",
    'COPY "public"."places" ("id") FROM stdin;',
    "1",
    "\\.",
    "",
    "SELECT pg_catalog.setval('public.places_id_seq', 1, true);",
  ].join("\n");
  assert.deepEqual(parseCopyRowCounts(sql), { places: 1 });
});

test("refuses a data dump that ends inside a COPY block", () => {
  const sql = ['COPY "public"."places" ("id") FROM stdin;', "1", "2"].join("\n");
  assert.throws(() => parseCopyRowCounts(sql), /truncated/);
});

test("refuses an empty dump file", () => {
  assert.throws(
    () => assertDumpFiles({ "roles.sql": 120, "schema.sql": 0, "data.sql": 900 }),
    /schema\.sql is empty/,
  );
  assert.deepEqual(assertDumpFiles({ "data.sql": 1 }), { "data.sql": 1 });
});

test("accepts a data dump that looks like the real database", () => {
  const counts = parseCopyRowCounts(fullDump());
  assert.equal(assertDataDump(counts), counts);
});

test("refuses a dump with no COPY blocks at all", () => {
  assert.throws(() => assertDataDump({}), /no COPY blocks/);
  assert.throws(() => assertDataDump({}, { allowEmpty: true }), /no COPY blocks/);
});

test("refuses a dump covering suspiciously few tables", () => {
  const counts = parseCopyRowCounts(dataDump([{ table: REQUIRED_TABLE, rows: 5 }]));
  assert.throws(
    () => assertDataDump(counts),
    new RegExp(`fewer than the expected ${MINIMUM_TABLE_COUNT}`),
  );
});

test("refuses a dump that carries no rows for the required table", () => {
  const counts = parseCopyRowCounts(
    dataDump([
      { table: "institutions", rows: 1 },
      { table: "campuses", rows: 1 },
      { table: "place_categories", rows: 1 },
      { table: "buildings", rows: 1 },
      { table: REQUIRED_TABLE, rows: 0 },
    ]),
  );
  assert.throws(() => assertDataDump(counts), new RegExp(`no rows for "${REQUIRED_TABLE}"`));
  assert.equal(assertDataDump(counts, { allowEmpty: true }), counts);
});

test("builds a manifest the freshness check can read", () => {
  const startedAt = new Date("2026-08-21T03:00:00.000Z");
  const finishedAt = new Date("2026-08-21T03:01:30.000Z");
  const manifest = buildManifest({
    objectKey: buildObjectKey(startedAt),
    bytes: 4096,
    sha256: "abc123",
    rowCounts: { places: 400, users: 12 },
    startedAt,
    finishedAt,
  });

  assert.deepEqual(manifest, {
    object_key: "daily/2026/08/ubikas-20260821T030000Z.tar.gz.age",
    checksum_key: "daily/2026/08/ubikas-20260821T030000Z.tar.gz.age.sha256",
    bytes: 4096,
    sha256: "abc123",
    started_at: "2026-08-21T03:00:00.000Z",
    finished_at: "2026-08-21T03:01:30.000Z",
    total_rows: 412,
    row_counts: { places: 400, users: 12 },
  });
});

test("the manifest carries counts only, never dumped values", () => {
  const manifest = buildManifest({
    objectKey: "daily/2026/08/x.tar.gz.age",
    bytes: 1,
    sha256: "a",
    rowCounts: { leads: 3 },
    startedAt: new Date(0),
    finishedAt: new Date(0),
  });
  assert.deepEqual(Object.keys(manifest.row_counts), ["leads"]);
  assert.equal(manifest.row_counts.leads, 3);
});

test("prefers the global CLI that setup-cli installs and falls back to the workspace copy", () => {
  assert.deepEqual(supabaseCommand({ hasGlobalCli: true }), { command: "supabase", prefix: [] });
  assert.deepEqual(supabaseCommand({ hasGlobalCli: false }), {
    command: "pnpm",
    prefix: ["--filter", "@ubikas/backend", "exec", "supabase"],
  });
});


test("checks for the AWS CLI only when it will actually upload", () => {
  assert.deepEqual(requiredBinaries({ dryRun: true }), ["age", "tar"]);
  assert.deepEqual(requiredBinaries({ dryRun: false }), ["age", "tar", "aws"]);
});

test("every checked binary carries an install hint", () => {
  for (const binary of requiredBinaries({ dryRun: false })) {
    assert.ok(BINARY_INSTALL_HINTS[binary], `${binary} has no install hint`);
  }
});

/**
 * This repository is separate from the one holding the schema, so these two guards
 * cannot be checked against a live migration. They are asserted here so that a change
 * to either is a deliberate, reviewed edit rather than a silent drift.
 */
test("the emptiness guards match what the schema is expected to contain", () => {
  assert.equal(REQUIRED_TABLE, "places");
  assert.equal(MINIMUM_TABLE_COUNT, 5);
});

test("scrubs the secret parts of a connection string, keeping the useful ones", () => {
  const url =
    "postgresql://postgres.wuljfhq:sup3r-s3cret@aws-1-sa-east-1.pooler.supabase.com:5432/postgres";
  const raw = [
    `failed to connect to ${url}`,
    "dial tcp: lookup aws-1-sa-east-1.pooler.supabase.com: no such host",
    "password authentication failed for user postgres.wuljfhq",
  ].join("\n");
  const scrubbed = scrubConnectionString(raw, url);

  assert.ok(!scrubbed.includes("sup3r-s3cret"), "the password survived");
  assert.ok(!scrubbed.includes("postgres.wuljfhq"), "the project ref survived");
  assert.ok(!scrubbed.includes(url), "the whole url survived");

  // The host is not a secret, and this is the line that actually explains a failure.
  assert.match(scrubbed, /no such host/);
  assert.match(scrubbed, /aws-1-sa-east-1\.pooler\.supabase\.com/);
});

test("scrubs a connection string the tool composed on its own", () => {
  const scrubbed = scrubConnectionString("dialing postgres://someone:pw@example.com:5432/db now", "");
  assert.ok(!scrubbed.includes("pw@example.com"));
  assert.match(scrubbed, /dialing <db-url> now/);
});

test("a short username or password never mangles ordinary diagnostics", () => {
  const raw = "pg_dump: error: server version 17.6; pg_dump version 16.4";
  assert.equal(scrubConnectionString(raw, "postgresql://u:p@h:5432/d"), raw);
});

test("keeps the line that names the real cause", () => {
  const url = "postgresql://postgres.abc:longpassword@db.example.supabase.co:6543/postgres";
  const raw = "pg_dump: error: unsupported startup parameter in transaction pooling mode";
  assert.equal(scrubConnectionString(raw, url), raw);
});

test("accepts a well-formed session pooler connection string", () => {
  assert.equal(
    describeDatabaseUrlProblem(
      "postgresql://postgres.abcdef:s3cret@aws-1-sa-east-1.pooler.supabase.com:5432/postgres",
    ),
    null,
  );
  assert.equal(describeDatabaseUrlProblem("postgres://u:pw@127.0.0.1:54322/postgres"), null);
});

test("names which part of a bad connection string is wrong", () => {
  const cases = [
    [" postgresql://u:p@h:5432/d", /whitespace/],
    ["postgresql://u:p@h:5432/d\n", /whitespace/],
    ["https://abcdef.supabase.co", /project API URL/],
    ["aws-1-sa-east-1.pooler.supabase.com:5432", /must start with/],
    ["postgresql://postgres.abcdef@host:5432/postgres", /carries no password/],
    ["postgresql://u:[YOUR-PASSWORD]@h:5432/d", /placeholder/],
    ["postgresql://u:p@h:6543/d", /transaction pooling mode/],
  ];
  for (const [value, expected] of cases) {
    assert.match(describeDatabaseUrlProblem(value) ?? "", expected, `for ${JSON.stringify(value)}`);
  }
});

test("no diagnostic ever repeats the value it rejected", () => {
  const secret = "postgresql://postgres.abcdef:sup3r-s3cret@h:6543/postgres";
  const problem = describeDatabaseUrlProblem(secret);
  assert.ok(problem);
  assert.ok(!problem.includes("sup3r-s3cret"));
  assert.ok(!problem.includes("abcdef"));
});

test("finds the project ref in either connection style", () => {
  assert.equal(
    supabaseProjectRef("postgresql://postgres.wuljfhqlnejnsvfzuvah:p@aws-1.pooler.supabase.com:5432/postgres"),
    "wuljfhqlnejnsvfzuvah",
  );
  assert.equal(
    supabaseProjectRef("postgresql://postgres:p@db.wuljfhqlnejnsvfzuvah.supabase.co:5432/postgres"),
    "wuljfhqlnejnsvfzuvah",
  );
  assert.equal(supabaseProjectRef("postgresql://postgres:p@127.0.0.1:54322/postgres"), null);
  assert.equal(supabaseProjectRef("not a url"), null);
});

test("keeps the project ref out of a diagnosable error", () => {
  const url = "postgresql://postgres:pw123456@db.wuljfhqlnejnsvfzuvah.supabase.co:5432/postgres";
  const raw = [
    'pg_dumpall: error: connection to server at "db.wuljfhqlnejnsvfzuvah.supabase.co"',
    "(2600:1f1e:75b:4b04::1), port 5432 failed: Network is unreachable",
  ].join("\n");
  const scrubbed = scrubConnectionString(raw, url);

  assert.ok(!scrubbed.includes("wuljfhqlnejnsvfzuvah"), "the project ref survived");
  assert.match(scrubbed, /Network is unreachable/, "the cause was thrown away");
});

test("does not redact the generic postgres user out of unrelated text", () => {
  const url = "postgresql://postgres:pw123456@db.abcdefghij.supabase.co:5432/postgres";
  const raw = "Status: Downloaded newer image for ghcr.io/supabase/postgres:17.6.1.106";
  assert.equal(scrubConnectionString(raw, url), raw);
});

test("rejects the IPv6-only direct host before anything expensive runs", () => {
  assert.match(
    describeDatabaseUrlProblem(
      "postgresql://postgres:pw123456@db.wuljfhqlnejnsvfzuvah.supabase.co:5432/postgres",
    ) ?? "",
    /IPv6 only.*session\s+pooler/s,
  );
  assert.equal(
    describeDatabaseUrlProblem(
      "postgresql://postgres.wuljfhqlnejnsvfzuvah:pw123456@aws-1-sa-east-1.pooler.supabase.com:5432/postgres",
    ),
    null,
  );
});
