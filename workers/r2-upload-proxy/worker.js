/**
 * R2 Upload Proxy untuk admin panel Dwiefoss.
 *
 * Kenapa proxy, bukan upload langsung dari browser ke R2?
 * Secret R2 tidak boleh ada di frontend (semua pengunjung bisa baca).
 * Worker ini pegang akses R2 via binding, browser cuma kirim file + sandi.
 *
 * DEPLOY (tanpa install apa2, via dashboard):
 *   1. Cloudflare dashboard kiri: Compute > Workers > Create > Hello World
 *      (atau "Create Worker"), beri nama misal: dwiefoss-upload
 *   2. Paste SELURUH file ini ke editor Worker > Deploy
 *   3. Worker > Settings > Bindings > Add > R2 bucket:
 *        Variable name = IMAGES, Bucket = dwifoss-images
 *   4. Worker > Settings > Variables & Secrets, tambah:
 *        SUPABASE_URL      = https://ehjnkcvozjdlscuqfqzb.supabase.co
 *        SUPABASE_ANON_KEY = <anon key dari index.html, sebagai Secret>
 *        ADMIN_EMAILS      = <email admin, koma-pemisah jika >1, sebagai Secret>
 *      (UPLOAD_SECRET lama & PUBLIC_BASE tetap seperti sebelumnya)
 *   5. Settings > Triggers: catat URL https://dwiefoss-upload.<akun>.workers.dev
 *   6. Di index.html: uploadToR2 mengirim token login admin (Bearer),
 *      TIDAK lagi memakai R2_UPLOAD_SECRET di source code.
 *
 * MASA TRANSISI (agar upload admin tidak putus saat deploy):
 *   Worker v2 ini menerima DUA cara auth — token admin (baru) ATAU
 *   x-upload-secret lama. Setelah client baru live & upload admin teruji,
 *   hapus variable LEGACY_UPLOAD_SECRET di bawah (cukup hapus dari dashboard)
 *   agar jalur secret-statis mati total, lalu rotate UPLOAD_SECRET.
 *
 * API:
 *   POST /upload?key=<path/di/bucket.ext>&contentType=image/webp
 *   Header: Authorization: Bearer <supabase access_token admin>
 *   Body: bytes file (bukan multipart, langsung blob)
 *   -> 200 { "url": "<PUBLIC_BASE>/<key>" }
 *
 *   GET /img/<path/di/bucket.ext>
 *   Serve publik langsung dari R2 (pengganti r2.dev yang diblokir sebagian
 *   provider Indonesia). Header Cache-Control 1 tahun, key selalu unik per
 *   upload sehingga aman immutable.
 *   -> 200 image / 404 { "error": "Not found" }
 *
 * Batas: max ~10MB/file (foto WebP terkompres admin <1MB, aman).
 */

const ALLOWED_ORIGINS = [
  "https://www.dwiefoss.id",
  "https://dwiefoss.id",
  "https://dwiefoss.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-upload-secret",
    "Access-Control-Max-Age": "86400",
  };
}

function safeKey(raw) {
  // cegah path traversal: hanya huruf, angka, / - _ .
  const k = (raw || "").replace(/^\/+/, "").slice(0, 300);
  if (!k || k.includes("..")) return null;
  if (!/^[\w\-./]+$/.test(k)) return null;
  return k;
}

// Validasi token login Supabase TANPA crypto di Worker: tanya langsung ke
// Auth server (GET /auth/v1/user). Token valid -> balas 200 + data user.
// Upload admin jarang (bukan per-pengunjung), latency tambahan ~100-300ms OK.
async function isAdminToken(req, env, token) {
  try {
    const base = (env.SUPABASE_URL || "").replace(/\/$/, "");
    const anon = env.SUPABASE_ANON_KEY || "";
    const allow = (env.ADMIN_EMAILS || "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!base || !anon || allow.length === 0) return false; // fail closed
    const r = await fetch(`${base}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return false;
    const user = await r.json();
    const email = (user && user.email ? String(user.email) : "").toLowerCase();
    return email !== "" && allow.includes(email);
  } catch {
    return false;
  }
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);

    // Serve gambar publik (pengganti r2.dev) — bisa dibuka semua provider.
    if (req.method === "GET") {
      const m = url.pathname.match(/^\/img\/(.+)$/);
      if (!m) {
        return new Response(JSON.stringify({ error: "Use POST /upload" }), {
          status: 404, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      let key;
      try { key = safeKey(decodeURIComponent(m[1])); } catch { key = null; }
      if (!key) {
        return new Response(JSON.stringify({ error: "Bad key" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      const obj = await env.IMAGES.get(key);
      if (!obj) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      return new Response(obj.body, {
        headers: {
          ...cors,
          "Content-Type": obj.httpMetadata?.contentType || "image/webp",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (req.method !== "POST" || url.pathname !== "/upload") {
      return new Response(JSON.stringify({ error: "Use POST /upload" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // AUTH: token login admin (baru) didahulukan, secret statis (lama)
    // hanya sebagai jembatan selama masa transisi deploy.
    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    let authorized = false;
    if (bearer) {
      authorized = await isAdminToken(req, env, bearer);
      if (!authorized) {
        return new Response(JSON.stringify({ error: "Sesi habis atau bukan admin — login ulang" }), {
          status: 401, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    } else if (env.LEGACY_UPLOAD_SECRET &&
               req.headers.get("x-upload-secret") === env.LEGACY_UPLOAD_SECRET) {
      authorized = true; // TODO(transisi): hapus blok ini setelah client baru live
    }
    if (!authorized) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const key = safeKey(url.searchParams.get("key"));
    if (!key) {
      return new Response(JSON.stringify({ error: "Bad key" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const contentType =
      url.searchParams.get("contentType") || "image/webp";
    if (!contentType.startsWith("image/")) {
      return new Response(JSON.stringify({ error: "Only images" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 10 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "Empty or >10MB" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    await env.IMAGES.put(key, buf, {
      httpMetadata: { contentType },
    });

    const base = (env.PUBLIC_BASE || "").replace(/\/$/, "");
    return new Response(JSON.stringify({ url: `${base}/${key}` }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
