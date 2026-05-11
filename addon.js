const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");

const DEVICE_ID = process.env.DEVICE_ID || "xhCxVPXwUCVpKiD3lArm2ILNc7BRdDrb";
const UPSTREAM_HOST = "www.arancialive.com";
const BASE_API = `https://${UPSTREAM_HOST}/api/app/1/${DEVICE_ID}`;
const MEDIA_BASE = `https://${UPSTREAM_HOST}`;
const PORT = Number(process.env.PORT) || 7000;
const ADDON_ID = "it.arancialive.stremio";
const PUBLIC_HOST = (process.env.ADDON_HOST || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const PROXY_URL = (process.env.PROXY_URL || "").replace(/\/$/, "");

const ARANCIA_HEADERS = {
  "User-Agent": "AranciaLiveApp/19 CFNetwork/3826.600.41 Darwin/24.6.0",
  Accept: "*/*",
  "Accept-Language": "it-IT,it;q=0.9",
  Connection: "keep-alive",
};

const CDN_HEADERS = {
  "User-Agent": "AranciaLiveApp/19 CFNetwork/3826.600.41 Darwin/24.6.0",
  Accept: "*/*",
  Connection: "keep-alive",
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function rewriteM3u8(content, upstreamUrl) {
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
}

function toProxyUrl(uri, base, basePath) {
  if (PROXY_URL) {
    if (/^https?:\/\//.test(uri)) {
      const m = uri.match(/^https?:\/\/([a-z0-9]+\.arancialive\.com)(\/.*)?$/);
      if (m) return `${PROXY_URL}/stream/${m[1]}${m[2] || "/"}`;
      return uri;
    }
    if (uri.startsWith("/")) return `${PROXY_URL}/stream/${base.hostname}${uri}`;
    return `${PROXY_URL}/stream/${base.hostname}${basePath}/${uri}`;
  }
  if (/^https?:\/\//.test(uri)) {
    const m = uri.match(/^https?:\/\/([a-z0-9]+\.arancialive\.com)(\/.*)?$/);
    if (m) return `${PUBLIC_HOST}/proxy/stream/${m[1]}${m[2] || "/"}`;
    return uri;
  }
  if (uri.startsWith("/")) return `${PUBLIC_HOST}/proxy/stream/${base.hostname}${uri}`;
  return `${PUBLIC_HOST}/proxy/stream/${base.hostname}${basePath}/${uri}`;
}

function fetchUpstream(targetUrl, headers, callback, redirectsLeft = 5) {
  const parsed = new URL(targetUrl);
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + (parsed.search || ""),
    method: "GET",
    headers: { ...headers, Host: parsed.hostname },
    rejectUnauthorized: false,
  };

  const req = https.request(options, (res) => {
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
}

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
    _idevento: info.IDEVENTO,
    _isPaid: isPaid,
    _isLive: isLive,
  };
}

const manifest = {
  id: ADDON_ID,
  version: "1.3.1",
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
    if (page === 1 && !search) {
      const catalog = await apiGet("/ondemandSuddivisi");
      if (catalog && Array.isArray(catalog)) {
        const all = catalog.flatMap((cat) =>
          (cat.ListaEventiOndemand || []).map((i) => buildMeta(i, "movie"))
        );
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

function videoUrlToProxy(videoUrl) {
  try {
    const parsed = new URL(videoUrl);
    if (PROXY_URL) {
      return `${PROXY_URL}/stream/${parsed.hostname}${parsed.pathname}`;
    }
    return `${PUBLIC_HOST}/proxy/stream/${parsed.hostname}${parsed.pathname}`;
  } catch {
    return videoUrl;
  }
}

const { getRouter } = require("stremio-addon-sdk");
const addonRouter = getRouter(builder.getInterface());

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost`);
  const pathname = reqUrl.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (pathname.startsWith("/proxy/stream/")) {
    const rest = pathname.slice("/proxy/stream/".length);
    const slashIdx = rest.indexOf("/");
    const cdnHost = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const cdnPath = slashIdx === -1 ? "/" : rest.slice(slashIdx);

    if (!/^[a-z0-9-]+\.arancialive\.com$/.test(cdnHost)) {
      res.writeHead(400);
      return res.end("Host non valido");
    }

    const targetUrl = `https://${cdnHost}${cdnPath}${reqUrl.search || ""}`;
    console.log(`[proxy] → ${targetUrl}`);

    fetchUpstream(targetUrl, CDN_HEADERS, (err, upstream, status) => {
      if (err || !upstream) {
        console.error("[proxy] errore:", err?.message);
        if (!res.headersSent) { res.writeHead(502); res.end("Bad Gateway"); }
        return;
      }

      const ct = upstream.headers["content-type"] || "";
      const isM3u8 = ct.includes("mpegurl") || cdnPath.includes(".m3u8");

      if (isM3u8) {
        const chunks = [];
        upstream.on("data", (c) => chunks.push(c));
        upstream.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const rewritten = rewriteM3u8(text, targetUrl);
          res.writeHead(status || 200, { "Content-Type": "application/x-mpegurl" });
          res.end(rewritten);
        });
        upstream.on("error", (e) => {
          console.error("[proxy m3u8]", e.message);
          if (!res.headersSent) { res.writeHead(502); res.end(); }
        });
      } else {
        res.writeHead(status || 200, { "Content-Type": ct || "application/octet-stream" });
        upstream.pipe(res);
      }
    });
    return;
  }

  addonRouter(req, res, () => {
    res.writeHead(404);
    res.end("Not found");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🍊 AranciaLive addon → ${PUBLIC_HOST}/manifest.json`);
  console.log(`🔀 Stream proxy → ${PROXY_URL || PUBLIC_HOST}`);
});
