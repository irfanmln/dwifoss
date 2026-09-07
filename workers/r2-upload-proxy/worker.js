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
 *   4. Worker > Settings > Variables & Secrets, tambah Secret:
 *        UPLOAD_SECRET = <buat sandi acak panjang, mis 32 karakter>
 *        PUBLIC_BASE   = https://pub-6c6bdb44140c425b838c5e00e38edd01.r2.dev
 *      (Var biasa boleh, tapi Secret lebih aman untuk UPLOAD_SECRET)
 *   5. Settings > Triggers: catat URL https://dwiefoss-upload.<akun>.workers.dev
 *   6. Di index.html set: const R2_UPLOAD_URL = "<url>/upload";
 *      const R2_UPLOAD_SECRET = "<sama dengan UPLOAD_SECRET>";
 *      (disimpan di kode admin — idealnya nanti pindah ke login session,
 *       tapi untuk sekarang jauh lebih aman daripada secret R2 di frontend)
 *
 * API:
 *   POST /upload?key=<path/di/bucket.ext>&contentType=image/webp
 *   Header: x-upload-secret: <UPLOAD_SECRET>
 *   Body: bytes file (bukan multipart, langsung blob)
 *   -> 200 { "url": "https://pub-...r2.dev/<key>" }
 *
 * Batas: max ~10MB/file (foto WebP terkompres admin <1MB, aman).
 */

const ALLOWED_ORIGINS = [
  "https://www.dwiefoss.id",
  "https://dwiefoss.id",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-upload-secret",
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

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/upload") {
      return new Response(JSON.stringify({ error: "Use POST /upload" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (req.headers.get("x-upload-secret") !== env.UPLOAD_SECRET) {
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
