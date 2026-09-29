// Database-URL settings validation (server/routes/settings.js).
//
// validateDatabaseUrl is the friendly gate in front of the device database_url.txt
// file: it must accept real Postgres connection strings (Supabase session pooler)
// and reject the mistakes a user is most likely to paste — an https:// REST URL,
// a blank field, or something that is not a URL at all.

let pass = 0;
function ok(cond, name) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  pass++;
  console.log("ok:", name);
}

const { validateDatabaseUrl } = await import("../server/routes/settings.js");

// Accepts: Supabase-style session pooler URLs, plain postgres:// URLs.
ok(validateDatabaseUrl("postgresql://postgres.abcd:[SECURITY_DATA]@aws-0-us-east-1.pooler.supabase.com:5432/postgres") === null,
  "accepts Supabase session pooler URL");
ok(validateDatabaseUrl("postgres://user:pw@localhost:5432/cognos") === null,
  "accepts plain postgres:// URL");
ok(validateDatabaseUrl("  postgresql://user:pw@host/db  ") === null,
  "trims surrounding whitespace");

// Rejects: the Supabase REST endpoint people grab by mistake, blanks, junk.
const httpsErr = validateDatabaseUrl("https://abcdefgh.supabase.co");
ok(typeof httpsErr === "string" && httpsErr.includes("https://"), "rejects https:// REST URL with a helpful message");
ok(typeof validateDatabaseUrl("") === "string", "rejects empty string");
ok(typeof validateDatabaseUrl("   ") === "string", "rejects whitespace-only string");
ok(typeof validateDatabaseUrl("not a url") === "string", "rejects non-URL text");
ok(typeof validateDatabaseUrl("mysql://user:pw@host/db") === "string", "rejects non-postgres scheme");
ok(typeof validateDatabaseUrl("postgresql://" + "x".repeat(2000)) === "string", "rejects absurdly long URL");

console.log(`\nsettings-dburl: ${pass} checks passed`);
