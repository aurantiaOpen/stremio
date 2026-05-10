const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");

// ─── Configurazione ───────────────────────────────────────────────────────────
const DEVICE_ID = process.env.DEVICE_ID || "xhCxVPXwUCVpKiD3lArm2ILNc7BRdDrb";
const UPSTREAM_HOST = "www.arancialive.com";
const BASE_API = `https://${UPSTREAM_HOST}/api/app/1/${DEVICE_ID}`;
const MEDIA_BASE = `https://${UPSTREAM_HOST}`;
const PORT = Number(process.env.PORT) || 7000;
const ADDON_ID = "it.arancialive.stremio";

const ARANCIA_HEADERS = {
  "User-Agent": "AranciaLiveApp/19 CFNetwork/3826.600.41 Darwin/24.6.0",
  "Accept": "*/*",
  "Accept-Language": "it-IT,it;q=0.9",
  "Connection": "keep-alive",
};

const CDN_HEADERS = {
  "User-Agent": "AranciaLiveApp/19 CFNetwork/3826.600.41 Darwin/24.6.0",
  "Accept": "*/*",
  "Connection": "keep-alive",
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── API helper con gestione errori robusta ──────────────────────────────────
async function apiGet(path) {
  const targetUrl = `${BASE_API}${path}`;
  try {
    const res = await fetch(targetUrl, {
      headers: ARANCIA_HEADERS,
      agent: httpsAgent,
      redirect: "follow",
      timeout: 15000 // 15 secondi di timeout
    });
    
    if (!res.ok) {
      console.error(`[API ERROR] ${path} Status: ${res.status}`);
      return null;
    }
    
    return await res.json();
  } catch (e) {
    console.error(`[API CRASH] ${path}:`, e.message);
    return null;
  }
}

// ─── Logica Proxy ────────────────────────────────────────────────────────────
function rewriteM3u8(content, upstreamUrl) {
  try {
    const base = new URL(upstreamUrl);
    const basePath = base.pathname.replace(/\/[^/]*$/, "");

    return content
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) =>
            `URI="${toProxyUrl(uri, base, basePath)}"`
          );
        }
        if (!trimmed.startsWith("#")) {
          return toProxyUrl(trimmed, base, basePath);
        }
        return line;
      })
      .join("\n");
  } catch (e) {
    return content;
  }
}

function toProxyUrl(uri, base, basePath) {
  if (/^https?:\/\//.test(uri)) {
    const m = uri.match(/^https?:\/\/([a-z0-9]+\.arancialive\.com)(\/.*)?$/);
    if (m) return `/proxy/stream/${m[1]}${m[2] || "/"}`;
    return uri;
  }
  if (uri.startsWith("/")) return `/proxy/stream/${base.hostname}${uri}`;
  return `/proxy/stream/${base.hostname}${basePath}/${uri}`;
}

function fetchUpstream(targetUrl, headers, callback, redirectsLeft = 5) {
  try {
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method: "GET",
      headers: { ...headers, Host: parsed.hostname },
      rejectUnauthorized: false,
    };

    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(options, (res) => {
      const { statusCode, headers: resHeaders } = res;
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
  } catch (e) {
    callback(e, null, 0);
  }
}

// ─── Helpers Meta ────────────────────────────────────────────────────────────
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
    description: (info.Descrizione || "").trim() + (isPaid ? "\n\n⚠️ A PAGAMENTO" : "") + (isLive ? "\n\n🔴 LIVE" : ""),
    releaseInfo: year ? String(year) : undefined,
    behaviorHints: { defaultVideoId: id, isLive },
  };
}

// ─── Manifest & Handlers ─────────────────────────────────────────────────────
const manifest = {
  id: ADDON_ID,
  version: "1.1.1",
  name: "AranciaLive",
  description: "Eventi live e on demand di AranciaLive",
  logo: `${MEDIA_BASE}/apple-touch-icon.png`,
  catalogs: [
    { id: "arancialive-live", type: "tv", name: "🔴 Live" },
    { id: "arancialive-ondemand", type: "movie", name: "📼 On Demand", extra: [{ name: "search" }, { name: "skip" }] },
  ],
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "tv"],
  idPrefixes: ["al_"],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    if (id === "arancialive-live") {
      const data = await apiGet("/live/list");
      if (!Array.isArray(data)) return { metas: [] };
      return { metas: data.map(i => buildMeta(i, "tv")) };
    }

    if (id === "arancialive-ondemand") {
      const skip = parseInt(extra?.skip || 0);
      const page = Math.floor(skip / 20) + 1;
      const data = await apiGet(`/ondemand/list/${page}`);
      if (!Array.isArray(data)) return { metas: [] };
      return { metas: data.map(i => buildMeta(i, "movie")), cacheMaxAge: 3600 };
    }
  } catch (e) {
    console.error("Catalog Error:", e);
  }
  return { metas: [] };
});

builder.defineMetaHandler(async ({ id, type }) => {
  try {
    if (!id.startsWith("al_")) return { meta: null };
    const idevento = id.replace("al_", "");
    
    const [live, ondemand] = await Promise.all([
      apiGet("/live/list"),
      apiGet("/ondemandSuddivisi")
    ]);

    let found = (live || []).find(e => (e.liveinfo?.IDEVENTO || e.IDEVENTO).toString() === idevento);
    
    if (!found && Array.isArray(ondemand)) {
      for (const cat of ondemand) {
        found = (cat.ListaEventiOndemand || []).find(e => (e.liveinfo?.IDEVENTO || e.IDEVENTO).toString() === idevento);
        if (found) break;
      }
    }

    if (found) {
      return { meta: buildMeta(found, type) };
    }
  } catch (e) {
    console.error("Errore MetaHandler:", e.message);
  }
  return { meta: null };
});


builder.defineStreamHandler(async ({ id }) => {
  try {
    const idevento = id.replace("al_", "");
    const videos = await apiGet(`/ondemand/video/${idevento}/1`);
    if (!Array.isArray(videos)) return { streams: [] };

    const streams = videos.filter(v => v.VideoUrl).map(v => ({
      title: v.Nome || "Guarda",
      url: `http://127.0.0.1:${PORT}/proxy/stream/${new URL(v.VideoUrl).hostname}${new URL(v.VideoUrl).pathname}`,
    }));
    return { streams };
  } catch (e) {
    return { streams: [] };
  }
});

// ─── Server Unificato ────────────────────────────────────────────────────────
const addonInterface = builder.getInterface();
const server = http.createServer((req, res) => {
  // Fix per la deprecazione di url.parse()
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const fullUrl = new URL(req.url, `${protocol}://${req.headers.host}`);
  const pathname = fullUrl.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // Proxy logic
  if (pathname.startsWith("/proxy/stream/")) {
    const rest = pathname.slice("/proxy/stream/".length);
    const slashIdx = rest.indexOf("/");
    const cdnHost = rest.slice(0, slashIdx);
    const cdnPath = rest.slice(slashIdx);
    const targetUrl = `https://${cdnHost}${cdnPath}${fullUrl.search}`;

    fetchUpstream(targetUrl, CDN_HEADERS, (err, upstream, status) => {
      if (err || !upstream) {
        res.writeHead(502); return res.end();
      }
      const ct = upstream.headers["content-type"] || "";
      if (ct.includes("mpegurl") || pathname.endsWith(".m3u8")) {
        let body = "";
        upstream.on("data", c => body += c);
        upstream.on("end", () => {
          res.writeHead(status, { "Content-Type": "application/x-mpegurl" });
          res.end(rewriteM3u8(body, targetUrl));
        });
      } else {
        res.writeHead(status, { "Content-Type": ct });
        upstream.pipe(res);
      }
    });
    return;
  }

  // Stremio Addon Logic
  addonInterface.get({ url: req.url, headers: req.headers }, (code, headers, body) => {
    res.writeHead(code, headers);
    res.end(body);
  });
});

// GESTIONE GLOBALE ERRORI PER EVITARE IL CRASH
process.on('unhandledRejection', (reason) => {
  console.error('Critico: Promessa non gestita:', reason);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🍊 AranciaLive Pronto su porta ${PORT}`);
});
