const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const url = require("url");

// ─── Configurazione ───────────────────────────────────────────────────────────
const DEVICE_ID = process.env.DEVICE_ID || "xhCxVPXwUCVpKiD3lArm2ILNc7BRdDrb";
const UPSTREAM_HOST = "www.arancialive.com";
const BASE_API = `https://${UPSTREAM_HOST}/api/app/1/${DEVICE_ID}`;
const MEDIA_BASE = `https://${UPSTREAM_HOST}`;
const PORT = Number(process.env.PORT) || 7000;
const ADDON_ID = "it.arancialive.stremio";

// Header identici all'app ufficiale (estratti dall'APK)
const ARANCIA_HEADERS = {
  "User-Agent": "AranciaLiveApp/19 CFNetwork/3826.600.41 Darwin/24.6.0",
  Accept: "*/*",
  "Accept-Language": "it-IT,it;q=0.9",
  Connection: "keep-alive",
};

// Per CDN m3u8/ts: niente Accept-Encoding così arriva testo leggibile
const CDN_HEADERS = {
  "User-Agent": "AranciaLiveApp/19 CFNetwork/3826.600.41 Darwin/24.6.0",
  Accept: "*/*",
  Connection: "keep-alive",
};

// Agent che ignora TLS scaduto (il cert di arancialive è scaduto, come nel proxy ufficiale)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Proxy integrato ─────────────────────────────────────────────────────────
// Riscrive gli URL m3u8 in modo che i segmenti .ts passino per il nostro proxy
// (necessario perché il CDN non ha header CORS e Stremio deve scaricare i segmenti)
function rewriteM3u8(content, upstreamUrl) {
  const base = new URL(upstreamUrl);
  const basePath = base.pathname.replace(/\/[^/]*$/, "");

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // rewrite URI="..." negli attributi dei tag
      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) =>
          `URI="${toProxyUrl(uri, base, basePath)}"`
        );
      }
      // righe URI (non commenti)
      if (!trimmed.startsWith("#")) {
        return toProxyUrl(trimmed, base, basePath);
      }
      return line;
    })
    .join("\n");
}

function toProxyUrl(uri, base, basePath) {
  // URI assoluto
  if (/^https?:\/\//.test(uri)) {
    const m = uri.match(/^https?:\/\/([a-z0-9]+\.arancialive\.com)(\/.*)?$/);
    if (m) return `/proxy/stream/${m[1]}${m[2] || "/"}`;
    return uri;
  }
  // URI relativo assoluto
  if (uri.startsWith("/")) {
    return `/proxy/stream/${base.hostname}${uri}`;
  }
  // URI relativo
  return `/proxy/stream/${base.hostname}${basePath}/${uri}`;
}

function fetchUpstream(targetUrl, headers, callback, redirectsLeft = 5) {
  const parsed = new URL(targetUrl);
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + (parsed.search || ""),
    method: "GET",
    headers: { ...headers, Host: parsed.hostname },
    rejectUnauthorized: false, // cert scaduto sul server arancialive
  };

  const req = https.request(options, (res) => {
    const { statusCode, headers: resHeaders } = res;
    // gestione redirect
    if (statusCode >= 300 && statusCode < 400 && resHeaders.location && redirectsLeft > 0) {
      res.resume();
      const next = resHeaders.location.startsWith("http")
        ? resHeaders.location
        : new URL(resHeaders.location, targetUrl).toString();
      return fetchUpstream(next, headers, callback, redirectsLeft - 1);
    }
    callback(null, res, statusCode);
  });
  req.on("error", (err) => callback(err, null, 0));
  req.end();
}

// ─── API helper (usa fetch con agent no-verify) ───────────────────────────────
async function apiGet(path) {
  const targetUrl = `${BASE_API}${path}`;
  try {
    const res = await fetch(targetUrl, {
      headers: ARANCIA_HEADERS,
      agent: httpsAgent,
      redirect: "follow",
    });
    if (!res.ok) {
      console.error(`[API] ${path} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[API] ${path} error:`, e.message);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function posterUrl(u) {
  if (!u) return null;
  return u.startsWith("http") ? u : `${MEDIA_BASE}${u}`;
}

function buildMeta(item, type = "movie") {
  const info = item.liveinfo || item;
  const id = `al_${info.IDEVENTO}`;
  const isPaid = info.IDTARIFFA !== 0;
  const isLive = info.Stato === 1;
  const year = info.DataEvento ? new Date(info.DataEvento).getFullYear() : null;

  return {
    id,
    type,
    name: info.Nome || `Evento #${info.IDEVENTO}`,
    poster: posterUrl(info.CopertinaUrl),
    background: posterUrl(info.CopertinaUrl),
    description:
      (info.Descrizione || "").trim() +
      (isPaid ? "\n\n⚠️ Contenuto a pagamento" : "") +
      (isLive ? "\n\n🔴 In diretta ora" : ""),
    releaseInfo: year ? String(year) : undefined,
    runtime: info.DurataMinuti ? `${info.DurataMinuti} min` : undefined,
    behaviorHints: { defaultVideoId: id, isLive },
    // usato internamente
    _idevento: info.IDEVENTO,
    _isPaid: isPaid,
    _isLive: isLive,
  };
}

// ─── Manifest ────────────────────────────────────────────────────────────────
const manifest = {
  id: ADDON_ID,
  version: "1.1.0",
  name: "AranciaLive",
  description: "Guarda gli eventi live e on demand di AranciaLive — Festa dei Ceri e tradizioni umbre",
  logo: `${MEDIA_BASE}/website/img/favicon196x196.png`,
  catalogs: [
    {
      id: "arancialive-live",
      type: "tv",
      name: "🔴 Live",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      id: "arancialive-ondemand",
      type: "movie",
      name: "📼 On Demand",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "tv"],
  idPrefixes: ["al_"],
};

// ─── Addon handlers ───────────────────────────────────────────────────────────
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const search = extra?.search?.toLowerCase() || null;
  const skip = extra?.skip ? parseInt(extra.skip) : 0;

  if (id === "arancialive-live") {
    const data = await apiGet("/live/list");
    if (!data || !Array.isArray(data)) return { metas: [] };
    let metas = data.map((i) => buildMeta(i, "tv"));
    if (search) metas = metas.filter((m) => m.name.toLowerCase().includes(search));
    return { metas };
  }

  if (id === "arancialive-ondemand") {
    const page = Math.floor(skip / 20) + 1;
    // Usa ondemandSuddivisi per la prima pagina (più completo), poi paginato
    if (page === 1 && !search) {
      const catalog = await apiGet("/ondemandSuddivisi");
      if (catalog && Array.isArray(catalog)) {
        const all = catalog.flatMap((cat) =>
          (cat.ListaEventiOndemand || []).map((i) => buildMeta(i, "movie"))
        );
        // dedup per IDEVENTO
        const seen = new Set();
        const metas = all.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        return { metas, cacheMaxAge: 300 };
      }
    }
    const data = await apiGet(`/ondemand/list/${page}`);
    if (!data || !Array.isArray(data)) return { metas: [] };
    let metas = data.map((i) => buildMeta(i, "movie"));
    if (search) metas = metas.filter((m) => m.name.toLowerCase().includes(search));
    return { metas, cacheMaxAge: 300 };
  }

  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith("al_")) return { meta: null };
  const idevento = parseInt(id.replace("al_", ""));

  const catalog = await apiGet("/ondemandSuddivisi");
  if (catalog && Array.isArray(catalog)) {
    for (const cat of catalog) {
      const found = (cat.ListaEventiOndemand || []).find(
        (e) => (e.liveinfo?.IDEVENTO ?? e.IDEVENTO) === idevento
      );
      if (found) {
        const meta = buildMeta(found, type);
        meta.id = id;
        return { meta };
      }
    }
  }

  const live = await apiGet("/live/list");
  if (live && Array.isArray(live)) {
    const found = live.find((e) => (e.liveinfo?.IDEVENTO ?? e.IDEVENTO) === idevento);
    if (found) {
      const meta = buildMeta(found, "tv");
      meta.id = id;
      return { meta };
    }
  }

  return { meta: null };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (!id.startsWith("al_")) return { streams: [] };
  const idevento = parseInt(id.replace("al_", ""));

  const videos = await apiGet(`/ondemand/video/${idevento}/1`);
  if (!videos || !Array.isArray(videos) || !videos.length) {
    console.log(`[stream] nessun video per evento ${idevento}`);
    return { streams: [] };
  }

  const streams = videos
    .filter((v) => v.VideoUrl)
    .map((v) => {
      // Riscrive l'URL .m3u8 per passare dal proxy integrato
      // così i segmenti .ts vengono proxati con gli header giusti
      const proxyM3u8 = videoUrlToProxy(v.VideoUrl);
      return {
        title: v.Nome
          ? `▶ ${v.Nome}${v.Durata ? ` (${v.Durata} min)` : ""}`
          : "▶ Guarda",
        url: proxyM3u8,
        behaviorHints: { notWebReady: false },
      };
    });

  console.log(`[stream] evento ${idevento}: ${streams.length} stream trovati`);
  return { streams };
});

// Converte un URL VideoUrl assoluto in una URL proxy locale
function videoUrlToProxy(videoUrl) {
  try {
    const parsed = new URL(videoUrl);
    // es: https://c10.arancialive.com/ondemand/foo/index.m3u8
    // → http://localhost:PORT/proxy/stream/c10.arancialive.com/ondemand/foo/index.m3u8
    return `http://127.0.0.1:${PORT}/proxy/stream/${parsed.hostname}${parsed.pathname}`;
  } catch {
    return videoUrl;
  }
}

// ─── Server HTTP (addon + proxy) ─────────────────────────────────────────────
const addonInterface = builder.getInterface();

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname;

  // CORS per Stremio
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // ── Proxy trasparente per stream HLS ──────────────────────────────────────
  // GET /proxy/stream/{host}/{...path}
  if (pathname.startsWith("/proxy/stream/")) {
    const rest = pathname.slice("/proxy/stream/".length); // "c10.arancialive.com/ondemand/..."
    const slashIdx = rest.indexOf("/");
    const cdnHost = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const cdnPath = slashIdx === -1 ? "/" : rest.slice(slashIdx);

    // Whitelist host per sicurezza
    if (!/^[a-z0-9]+\.arancialive\.com$/.test(cdnHost)) {
      res.writeHead(400);
      return res.end("Host non valido");
    }

    const targetUrl = `https://${cdnHost}${cdnPath}${parsedUrl.search || ""}`;
    console.log(`[proxy] ${targetUrl}`);

    fetchUpstream(targetUrl, CDN_HEADERS, (err, upstream, status) => {
      if (err || !upstream) {
        console.error("[proxy] errore:", err?.message);
        res.writeHead(502);
        return res.end("Bad Gateway");
      }

      const ct = upstream.headers["content-type"] || "";
      const isM3u8 =
        ct.includes("mpegurl") ||
        cdnPath.endsWith(".m3u8") ||
        cdnPath.includes(".m3u8");

      if (isM3u8) {
        const chunks = [];
        upstream.on("data", (c) => chunks.push(c));
        upstream.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const rewritten = rewriteM3u8(text, targetUrl);
          res.writeHead(status || 200, {
            "Content-Type": "application/x-mpegurl",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(rewritten);
        });
      } else {
        // Segmenti .ts e altri file: pass-through diretto
        res.writeHead(status || 200, {
          "Content-Type": ct || "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
        });
        upstream.pipe(res);
      }
    });
    return;
  }

  // ── Addon Stremio ─────────────────────────────────────────────────────────
  // Stremio SDK usa callback-style; lo adattiamo manualmente
  addonInterface.get(
    { url: req.url, headers: req.headers },
    (statusCode, resHeaders, body) => {
      res.writeHead(statusCode, resHeaders);
      res.end(body);
    }
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🍊 AranciaLive Stremio Addon`);
  console.log(`   http://localhost:${PORT}/manifest.json`);
  console.log(`   Proxy stream: http://localhost:${PORT}/proxy/stream/{host}/{path}\n`);
});
