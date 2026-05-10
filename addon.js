const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

// ─── Configurazione API ───────────────────────────────────────────────────────
const BASE_URL = "https://www.arancialive.com/api/app/1";
const DEVICE_ID = "xhCxVPXwUCVpKiD3lArm2ILNc7BRdDrb"; // hardcoded nell'APK
const MEDIA_BASE = "https://www.arancialive.com";
const ADDON_ID = "it.arancialive.stremio";

const HEADERS = {
  Host: "www.arancialive.com",
  Accept: "*/*",
  "Accept-Language": "it-IT,it;q=0.9",
  Connection: "keep-alive",
  "Accept-Encoding": "identity",
  "User-Agent": "AranciaLiveApp/19 CFNetwork/3826.600.41 Darwin/24.6.0",
};

// ─── Manifest ────────────────────────────────────────────────────────────────
const manifest = {
  id: ADDON_ID,
  version: "1.0.0",
  name: "AranciaLive",
  description:
    "Guarda gli eventi live e on demand di AranciaLive — eventi della tradizione umbra (Festa dei Ceri, ecc.)",
  logo: "https://www.arancialive.com/apple-touch-icon.png",
  background: "https://www.arancialive.com/apple-touch-icon.png",
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

// ─── Helpers API ─────────────────────────────────────────────────────────────
async function apiGet(path) {
  const url = `${BASE_URL}/${DEVICE_ID}${path}`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`[arancialive] API error ${path}:`, e.message);
    return null;
  }
}

function posterUrl(url) {
  if (!url) return "https://www.arancialive.com/apple-touch-icon.png";
  return url.startsWith("http") ? url : `${MEDIA_BASE}${url}`;
}

// ─── Costruzione Meta ─────────────────────────────────────────────────────────
function buildMeta(item, type = "movie") {
  const info = item.liveinfo || item;
  const id = `al_${info.IDEVENTO}`;
  const isPaid = info.IDTARIFFA !== 0;
  const isLive = info.Stato === 1;

  return {
    id,
    type,
    name: info.Nome || `Evento #${info.IDEVENTO}`,
    poster: posterUrl(info.CopertinaUrl),
    description:
      (info.Descrizione || "") +
      (isPaid ? "\n\n⚠️ Contenuto a pagamento" : "") +
      (isLive ? "\n\n🔴 In diretta ora" : ""),
    background: posterUrl(info.CopertinaUrl),
    releaseInfo: info.DataEvento
      ? new Date(info.DataEvento).getFullYear().toString()
      : undefined,
    runtime: info.DurataMinuti ? `${info.DurataMinuti} min` : undefined,
    genres: [],
    links: [],
    behaviorHints: {
      defaultVideoId: id,
      isLive,
    },
    // campi extra per il client
    _idevento: info.IDEVENTO,
    _isPaid: isPaid,
    _isLive: isLive,
  };
}

// ─── Builder ─────────────────────────────────────────────────────────────────
const builder = new addonBuilder(manifest);

// ── CATALOG ──────────────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const search = extra && extra.search ? extra.search.toLowerCase() : null;
  const skip = extra && extra.skip ? parseInt(extra.skip) : 0;

  // Catalog LIVE
  if (id === "arancialive-live") {
    const data = await apiGet("/live/list");
    if (!data || !Array.isArray(data)) return { metas: [] };

    let metas = data.map((item) => buildMeta(item, "tv"));
    if (search) {
      metas = metas.filter((m) => m.name.toLowerCase().includes(search));
    }
    return { metas };
  }

  // Catalog ON DEMAND
  if (id === "arancialive-ondemand") {
    const page = Math.floor(skip / 20) + 1;
    const data = await apiGet(`/ondemand/list/${page}`);
    if (!data || !Array.isArray(data)) return { metas: [] };

    let metas = data.map((item) => buildMeta(item, "movie"));
    if (search) {
      metas = metas.filter((m) => m.name.toLowerCase().includes(search));
    }
    return { metas, cacheMaxAge: 300 };
  }

  return { metas: [] };
});

// ── META ──────────────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith("al_")) return { meta: null };

  const idevento = parseInt(id.replace("al_", ""));

  // Prova prima nel catalogo on demand raggruppato
  const catalog = await apiGet("/ondemandSuddivisi");
  if (catalog && Array.isArray(catalog)) {
    for (const cat of catalog) {
      const found = (cat.ListaEventiOndemand || []).find(
        (e) => (e.liveinfo?.IDEVENTO || e.IDEVENTO) === idevento
      );
      if (found) {
        const meta = buildMeta(found, type);
        meta.id = id;
        return { meta };
      }
    }
  }

  // Prova nella lista live
  const live = await apiGet("/live/list");
  if (live && Array.isArray(live)) {
    const found = live.find(
      (e) => (e.liveinfo?.IDEVENTO || e.IDEVENTO) === idevento
    );
    if (found) {
      const meta = buildMeta(found, "tv");
      meta.id = id;
      return { meta };
    }
  }

  return { meta: null };
});

// ── STREAM ────────────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  if (!id.startsWith("al_")) return { streams: [] };

  const idevento = parseInt(id.replace("al_", ""));

  // Cerca se è un evento live attivo
  const liveList = await apiGet("/live/list");
  const liveEvent =
    liveList &&
    liveList.find &&
    liveList.find(
      (e) => (e.liveinfo?.IDEVENTO || e.IDEVENTO) === idevento
    );

  if (liveEvent) {
    const info = liveEvent.liveinfo || liveEvent;
    // Per il live si usa lo stream diretto via ApiKey se disponibile
    // altrimenti proviamo i video
    const videos = await apiGet(`/ondemand/video/${idevento}/1`);
    const streams = [];

    if (videos && videos.length) {
      for (const v of videos) {
        if (v.VideoUrl) {
          streams.push({
            title: v.Nome || "🔴 Live",
            url: v.VideoUrl,
            behaviorHints: { notWebReady: false },
          });
        }
      }
    }

    if (streams.length) return { streams };

    return {
      streams: [
        {
          title: "🔴 Live — richiede l'app AranciaLive",
          externalUrl: "https://www.arancialive.com",
        },
      ],
    };
  }

  // On demand — recupera i video dell'evento
  const videos = await apiGet(`/ondemand/video/${idevento}/1`);
  if (!videos || !videos.length) return { streams: [] };

  const streams = videos
    .filter((v) => v.VideoUrl && v.Stato === 1)
    .map((v) => ({
      title: v.Nome
        ? `▶ ${v.Nome}${v.Durata ? ` (${v.Durata} min)` : ""}`
        : "▶ Guarda",
      url: v.VideoUrl,
      subtitles: [],
      behaviorHints: { notWebReady: false },
    }));

  return { streams };
});

// ─── Avvio server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n🍊 AranciaLive Stremio Addon in ascolto su http://localhost:${PORT}`);
console.log(`   Manifest: http://localhost:${PORT}/manifest.json\n`);
