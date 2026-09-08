/**
 * Generate sitemap.xml + robots.txt statis dari data produk Supabase.
 * Slug HARUS identik dengan buildProductSlugMap() di index.html.
 *
 *   node scripts/generate-sitemap.mjs
 *   git add sitemap.xml robots.txt && git commit && git push
 *
 * Butuh scripts/.env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 * Jalankan ulang tiap ada produk baru/hapus (atau sebelum submit iklan).
 */
import { readFileSync, writeFileSync } from "node:fs";

try {
  const envText = readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BASE = "https://www.dwiefoss.id";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("ERROR: isi SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY di scripts/.env");
  process.exit(1);
}

// --- tiruan persis slugify + buildProductSlugMap di index.html ---
function slugify(str) {
  return (str || "").toString().toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function pg(table, select) {
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
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

const all = await pg("products", "id,brand,name,is_active,created_at");
const active = all.filter((p) => p.is_active !== false);

const groups = {};
for (const p of active) {
  const base = slugify(`${p.brand} ${p.name}`) || p.id;
  (groups[base] = groups[base] || []).push(p);
}
const urls = [{ loc: `${BASE}/`, changefreq: "daily", priority: "1.0" }];
for (const base of Object.keys(groups).sort()) {
  const ids = groups[base].slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  ids.forEach((p, i) => {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const lastmod = (p.created_at || "").slice(0, 10);
    urls.push({
      loc: `${BASE}/produk/${slug}`,
      changefreq: "weekly",
      priority: "0.8",
      lastmod: lastmod || undefined,
    });
  });
}

const xml =
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n` +
        (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : "") +
        `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    )
    .join("\n") +
  `\n</urlset>\n`;

writeFileSync("sitemap.xml", xml);
writeFileSync(
  "robots.txt",
  `User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${BASE}/sitemap.xml\n`
);
console.log(`OK: ${urls.length} URL (${urls.length - 1} produk) -> sitemap.xml + robots.txt`);
