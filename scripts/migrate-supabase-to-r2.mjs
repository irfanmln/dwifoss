/**
 * Migrasi gambar Supabase Storage (bucket `products`) -> Cloudflare R2.
 * JALAN DI PC SENDIRI. Jangan commit file .env ke git.
 *
 *   1. npm i @aws-sdk/client-s3
 *   2. copy scripts/.env.example -> scripts/.env lalu isi (service_role dari
 *      Supabase Dashboard > Project Settings > API, R2 keys dari Notepad Anda)
 *   3. node scripts/migrate-supabase-to-r2.mjs --dry-run   # cek dulu
 *   4. node scripts/migrate-supabase-to-r2.mjs            # eksekusi
 *   5. Ulangi aman (idempotent): URL yang sudah R2 di-skip otomatis.
 *
 * Catatan: butuh Node 18+ (fetch global). Membaca scripts/.env sederhana
 * (format KEY=value, tanpa库 tambahan).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry-run");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1], 10) : 0;

// --- load scripts/.env (tanpa dotenv) ---
try {
  const envText = readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* .env belum ada -> pakai env OS, error jelas di bawah */ }

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "dwifoss-images";
const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, "");
const OLD_MARKER = "/storage/v1/object/public/products/";

for (const [k, v] of Object.entries({
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: R2_ACCESS_KEY, R2_SECRET_ACCESS_KEY: R2_SECRET_KEY, R2_PUBLIC_BASE,
})) {
  if (!v) { console.error(`ERROR: ${k} kosong. Isi scripts/.env dulu.`); process.exit(1); }
}

const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

async function pg(table, select) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=${select}&offset=${offset}&limit=1000`,
      { headers: H }
    );
    if (!r.ok) throw new Error(`GET ${table}: ${r.status} ${await r.text()}`);
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function patch(table, id, col, url) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ [col]: url }),
  });
  if (!r.ok) throw new Error(`PATCH ${table}.${col} ${id}: ${r.status} ${await r.text()}`);
}

function keyFromUrl(oldUrl, fallback) {
  try {
    const p = new URL(oldUrl).pathname;
    if (p.includes(OLD_MARKER)) return p.split(OLD_MARKER)[1];
  } catch {}
  return `migrated/${fallback}.webp`;
}

let jobs = [];
for (const row of await pg("product_images", "id,image_url"))
  if (row.image_url) jobs.push(["product_images", "image_url", row.id, row.image_url, `product_images/${row.id}`]);
for (const row of await pg("product_variants", "id,image_url"))
  if (row.image_url) jobs.push(["product_variants", "image_url", row.id, row.image_url, `product_variants/${row.id}`]);
for (const row of await pg("banners", "id,desktop_image_url,mobile_image_url"))
  for (const col of ["desktop_image_url", "mobile_image_url"])
    if (row[col]) jobs.push(["banners", col, row.id, row[col], `banners/${row.id}-${col}`]);

jobs = jobs.filter((j) => !j[3].startsWith(R2_PUBLIC_BASE));
if (LIMIT) jobs = jobs.slice(0, LIMIT);
console.log(`Total file perlu migrasi: ${jobs.length}`);
if (DRY) { jobs.slice(0, 20).forEach((j) => console.log(`  [dry] ${j[0]}.${j[1]} id=${j[2]}`)); process.exit(0); }

let ok = 0, fail = 0;
const mapping = [["table", "column", "id", "old_url", "new_url"]];
for (const [table, col, id, oldUrl, fallback] of jobs) {
  const key = keyFromUrl(oldUrl, fallback);
  const newUrl = `${R2_PUBLIC_BASE}/${key}`;
  try {
    const dl = await fetch(oldUrl);
    if (!dl.ok) throw new Error(`download ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const ctype = (dl.headers.get("content-type") || "image/webp").split(";")[0];
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buf, ContentType: ctype }));
    await patch(table, id, col, newUrl);
    mapping.push([table, col, id, oldUrl, newUrl]);
    ok++;
    console.log(`  OK ${table}.${col} ${id} -> ${key}`);
  } catch (e) { fail++; console.log(`  FAIL ${table}.${col} ${id}: ${e.message}`); }
}
writeFileSync("scripts/r2-migration-mapping.csv", mapping.map((r) => r.join(",")).join("\n"));
console.log(`\nSelesai: ok=${ok} fail=${fail}. Mapping: scripts/r2-migration-mapping.csv`);
