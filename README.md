
---
title: arancialive plugin
emoji: 🍊
colorFrom: orange
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# 🍊 aranciaopen — stremio addon

plugin non ufficiale per guardare i contenuti di [arancialive](https://www.arancialive.com) direttamente in stremio.

## Funzionalità

- 📺 **catalogo live** — eventi in diretta ora
- 📼 **catalogo on demand** — tutti gli eventi registrati (Festa dei Ceri, ecc.)
- 🔴 **stream HLS** — riproduzione diretta via `.m3u8`
- 🆓 supporto contenuti gratuiti (IDTARIFFA = 0)

## installazione

### metodo 1 — manuale (localhost)

```bash
git clone <repo>
cd stremio-arancialive
npm install
npm start
```

Poi in stremio:
1. Vai su **addon** -> **community addons** -> icona ingranaggio
2. inserisci: `http://localhost:7000/manifest.json`
3. clicca **install**

### metodo 2 — deploy su render / railway

1. fai il fork del repo
2. deploy su [render](https://render.com) come **webservice** con `npm start`
3. usa l'URL pubblico `https://<tuo-app>.onrender.com/manifest.json` in stremio

## note tecniche

- usa il device ID hardcoded nell'APK android (`xhCxVPXwUCVpKiD3lArm2ILNc7BRdDrb`)
- i contenuti a pagamento (`IDTARIFFA != 0`) sono visibili in catalogo ma non riproducibili, ovviamente
- basato sull'API: doc a [aurantiaOpen/officialapi](https://github.com/aurantiaOpen/officialapi)

## variabili d'ambiente

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `PORT`    | `7000`  | porta del server HTTP |

## disclaimer

addon non ufficiale. non affiliato con AranciaLive.
