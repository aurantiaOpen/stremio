const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");

const DEVICE_ID     = process.env.DEVICE_ID;
const LIVE_PSW      = process.env.LIVE_PSW;
const UPSTREAM_HOST = "www.arancialive.com";
const BASE_API      = `https://${UPSTREAM_HOST}/api/app/1/${DEVICE_ID}`;
const MEDIA_BASE    = `https://${UPSTREAM_HOST}`;
const PORT          = Number(process.env.PORT) || 7000;
const ADDON_ID      = "it.arancialive.stremio";
const PUBLIC_HOST   = (process.env.ADDON_HOST || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const PROXY_URL     = (process.env.PROXY_URL || "").replace(/\/$/, "");

const ARANCIA_HEADERS = {
  "User-Agent": "AranciaLiveApp/19 CFNetwork/3826.600.41 Darwin/24.6.0",
  Accept: "*/*",
  "Accept-Language": "it-IT,it;q=0.9",
  Connection: "keep-alive",
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function posterUrl(u) {
  if (!u) return null;
  return u.startsWith("http") ? u : `${MEDIA_BASE}${u}`;
}

function videoUrlToProxy(videoUrl) {
  try {
    const parsed = new URL(videoUrl);
    if (PROXY_URL) return `${PROXY_URL}/stream/${parsed.hostname}${parsed.pathname}`;
    return videoUrl;
  } catch {
    return videoUrl;
  }
}

async function apiGet(path) {
  const url = `${BASE_API}${path}`;
  try {
    const res = await fetch(url, {
      headers: ARANCIA_HEADERS,
      agent: httpsAgent,
      redirect: "follow",
    });
    if (!res.ok) { console.error(`[API] ${path} → ${res.status}`); return null; }
    return await res.json();
  } catch (e) {
    console.error(`[API] ${path} error:`, e.message);
    return null;
  }
}

async function getVideos(idevento) {
  const url = PROXY_URL
    ? `${PROXY_URL}/${UPSTREAM_HOST}/api/app/1/${DEVICE_ID}/ondemand/video/${idevento}/1`
    : `${BASE_API}/ondemand/video/${idevento}/1`;
  try {
    const res = await fetch(url, { headers: ARANCIA_HEADERS, agent: httpsAgent, redirect: "follow" });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error(`[getVideos] ${idevento}:`, e.message);
    return null;
  }
}

async function getLiveStreamUrl() {
  const url =
    `https://${UPSTREAM_HOST}/admin/getUrlstreaming.ashx` +
    `?https=si&debug=no&psw=${encodeURIComponent(LIVE_PSW)}`;
  try {
    const res = await fetch(url, { headers: ARANCIA_HEADERS, agent: httpsAgent, redirect: "follow" });
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch (e) {
    console.error(`[live] error:`, e.message);
    return null;
  }
}

function isEventoInDiretta(info) {
  return (
    typeof info.TimeToStart === "number" &&
    info.TimeToStart <= 0 &&
    typeof info.TimeToEnd === "number" &&
    info.TimeToEnd > 0
  );
}

function buildMeta(item, type) {
  const info   = item.liveinfo || item;
  const id     = `al_${info.IDEVENTO}`;
  const isPaid = info.IDTARIFFA !== 0;
  const isLive = isEventoInDiretta(info);
  const year   = info.DataEvento ? new Date(info.DataEvento).getFullYear() : null;

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

function videosToEpisodes(videos, idevento) {
  return videos
    .filter((v) => v.VideoUrl)
    .map((v, idx) => ({
      id: `al_${idevento}:1:${idx + 1}`,
      title: v.Nome || `Episodio ${idx + 1}`,
      season: 1,
      episode: idx + 1,
      thumbnail: posterUrl(v.CopertinaUrl),
      released: v.Data ? new Date(v.Data) : undefined,
      overview: v.Descrizione || "",
    }));
}

const manifest = {
  id: ADDON_ID,
  version: "2.1.0",
  name: "AranciaLive",
  description: "Guarda gli eventi live e on demand di AranciaLive, direttamente in stremio",
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
      type: "series",
      name: "📼 On Demand",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
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
  types: ["series", "movie", "tv"],
  idPrefixes: ["al_"],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const search = extra?.search?.toLowerCase() || null;
  const skip   = extra?.skip ? parseInt(extra.skip) : 0;

  if (id === "arancialive-live") {
    const data = await apiGet("/live/list");
    if (!data || !Array.isArray(data)) return { metas: [] };
    let metas = data.map((i) => buildMeta(i, "tv"));
    if (search) metas = metas.filter((m) => m.name.toLowerCase().includes(search));
    return { metas };
  }

  if (id === "arancialive-ondemand") {
    const page = Math.floor(skip / 20) + 1;

    let rawItems = [];

    if (page === 1 && !search) {
      const catalog = await apiGet("/ondemandSuddivisi");
      if (catalog && Array.isArray(catalog)) {
        rawItems = catalog.flatMap((cat) => cat.ListaEventiOndemand || []);
      }
    }

    if (!rawItems.length) {
      const data = await apiGet(`/ondemand/list/${page}`);
      if (!data || !Array.isArray(data)) return { metas: [] };
      rawItems = data;
    }

    const seen = new Set();
    rawItems = rawItems.filter((i) => {
      const evId = i.liveinfo?.IDEVENTO ?? i.IDEVENTO;
      if (seen.has(evId)) return false;
      seen.add(evId);
      return true;
    });

    if (type === "movie") return { metas: [], cacheMaxAge: 300 };

    let metas = rawItems.map((i) => buildMeta(i, "series"));
    if (search) metas = metas.filter((m) => m.name.toLowerCase().includes(search));
    return { metas, cacheMaxAge: 300 };
  }

  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith("al_")) return { meta: null };

  const idevento = parseInt(id.replace("al_", "").split(":")[0]);

  let found = null;
  let isLiveEvent = false;

  const catalog = await apiGet("/ondemandSuddivisi");
  if (catalog && Array.isArray(catalog)) {
    for (const cat of catalog) {
      found = (cat.ListaEventiOndemand || []).find(
        (e) => (e.liveinfo?.IDEVENTO ?? e.IDEVENTO) === idevento
      );
      if (found) break;
    }
  }

  if (!found) {
    const live = await apiGet("/live/list");
    if (live && Array.isArray(live)) {
      found = live.find((e) => (e.liveinfo?.IDEVENTO ?? e.IDEVENTO) === idevento);
      if (found) isLiveEvent = true;
    }
  }

  if (!found) return { meta: null };

  if (isLiveEvent) {
    const meta = buildMeta(found, "tv");
    meta.id = `al_${idevento}`;
    return { meta };
  }

  const videos = await getVideos(idevento);
  const playableVideos = (videos || []).filter((v) => v.VideoUrl);

  const metaType = playableVideos.length <= 1 ? "movie" : "series";
  const meta = buildMeta(found, metaType);
  meta.id = `al_${idevento}`;

  if (metaType === "series" && playableVideos.length > 0) {
    meta.videos = videosToEpisodes(playableVideos, idevento);
  }

  return { meta };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (!id.startsWith("al_")) return { streams: [] };

  if (type === "tv") {
    const idevento  = parseInt(id.replace("al_", "").split(":")[0]);
    const liveList  = await apiGet("/live/list");
    const liveEvent = liveList?.find?.((e) => (e.liveinfo?.IDEVENTO ?? e.IDEVENTO) === idevento);

    const m3u8Url = await getLiveStreamUrl();
    if (!m3u8Url) return { streams: [] };

    const info        = liveEvent?.liveinfo || liveEvent || {};
    const eventName   = info.Nome || "AranciaLive";
    const timeToStart = info.TimeToStart;
    const inDiretta   = isEventoInDiretta(info);

    let title;
    if (inDiretta) {
      title = `🔴 ${eventName}`;
    } else if (typeof timeToStart === "number" && timeToStart > 0) {
      const h = Math.floor(timeToStart / 3600);
      const m = Math.floor((timeToStart % 3600) / 60);
      title = `⏳ ${eventName} - inizia tra ${h > 0 ? `${h}h ` : ""}${m}min`;
    } else {
      title = `🔴 ${eventName}`;
    }

    return {
      streams: [{ title, url: m3u8Url, behaviorHints: { notWebReady: false } }],
      cacheMaxAge: 0,
    };
  }

  if (type === "movie") {
    const idevento = parseInt(id.replace("al_", "").split(":")[0]);
    const videos   = await getVideos(idevento);
    if (!videos || !Array.isArray(videos)) return { streams: [] };

    const video = videos.find((v) => v.VideoUrl);
    if (!video) return { streams: [] };

    const durationStr = video.Durata ? ` (${video.Durata} min)` : "";
    return {
      streams: [{
        title: `▶ ${video.Nome || "Guarda"}${durationStr}`,
        url: videoUrlToProxy(video.VideoUrl),
        behaviorHints: { notWebReady: false },
      }],
      cacheMaxAge: 300,
    };
  }

  const parts    = id.replace("al_", "").split(":");
  const idevento = parseInt(parts[0]);
  const epIndex  = parts.length >= 3 ? parseInt(parts[2]) - 1 : 0;

  const videos = await getVideos(idevento);
  if (!videos || !Array.isArray(videos)) return { streams: [] };

  const filtered = videos.filter((v) => v.VideoUrl);
  const video    = filtered[epIndex];
  if (!video) return { streams: [] };

  const durationStr = video.Durata ? ` (${video.Durata} min)` : "";
  return {
    streams: [{
      title: `▶ ${video.Nome || `Episodio ${epIndex + 1}`}${durationStr}`,
      url: videoUrlToProxy(video.VideoUrl),
      behaviorHints: { notWebReady: false },
    }],
    cacheMaxAge: 300,
  };
});

const addonRouter = getRouter(builder.getInterface());

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  addonRouter(req, res, () => {
    res.writeHead(404);
    res.end("Not found");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🍊 AranciaLive addon ${PUBLIC_HOST}/manifest.json`);
  console.log(`🔀 Proxy ${PROXY_URL || "(nessuno, URL diretti)"}`);
});
