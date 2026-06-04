import * as PIXI from "/vendor/pixi.mjs";

const categoryColor = {
  law: 0x2f6fed,
  fire: 0xe4572e,
  ems: 0x2fbf71,
  traffic: 0xf4a261,
  unknown: 0x6f7d8c
};

let config = null;
let incidents = [];
let pixiApp = null;
let view = {
  center: { lat: 39.6908, lng: -83.8949 },
  zoom: 13
};
let dragging = false;
let dragStart = null;
let dragCenter = null;
let mapLayer = "osm";
let demoSource = null;
let liveCapture = {
  stream: null,
  recorder: null,
  busy: false,
  queue: [],
  active: false
};

const tileProviders = {
  osm: {
    name: "OpenStreetMap",
    attribution: "Map tiles © OpenStreetMap contributors",
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
  },
  hot: {
    name: "OSM Humanitarian",
    attribution: "Map tiles © OpenStreetMap contributors, Humanitarian OpenStreetMap Team",
    url: (z, x, y) => `https://a.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`
  },
  carto: {
    name: "Carto Roads",
    attribution: "© OpenStreetMap contributors, © CARTO",
    url: (z, x, y) => `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`
  }
};

const els = {
  tileLayer: document.querySelector("#tileLayer"),
  map: document.querySelector("#map"),
  title: document.querySelector("#title"),
  status: document.querySelector("#status"),
  feedLink: document.querySelector("#feedLink"),
  feedNotes: document.querySelector("#feedNotes"),
  modelNotes: document.querySelector("#modelNotes"),
  liveNotes: document.querySelector("#liveNotes"),
  liveFeedUrl: document.querySelector("#liveFeedUrl"),
  loadFeed: document.querySelector("#loadFeed"),
  openFeed: document.querySelector("#openFeed"),
  liveFeedFrame: document.querySelector("#liveFeedFrame"),
  startLiveParse: document.querySelector("#startLiveParse"),
  stopLiveParse: document.querySelector("#stopLiveParse"),
  liveParseStatus: document.querySelector("#liveParseStatus"),
  transcript: document.querySelector("#transcript"),
  parseButton: document.querySelector("#parseButton"),
  zoomIn: document.querySelector("#zoomIn"),
  zoomOut: document.querySelector("#zoomOut"),
  mapLayer: document.querySelector("#mapLayer"),
  resetMap: document.querySelector("#resetMap"),
  mapStatus: document.querySelector("#mapStatus"),
  attribution: document.querySelector(".attribution"),
  totalCount: document.querySelector("#totalCount"),
  plottedCount: document.querySelector("#plottedCount"),
  incidentList: document.querySelector("#incidentList")
};

async function boot() {
  config = await fetch("/api/config").then((response) => response.json());
  els.title.textContent = `${config.county.name} Signal Map`;
  els.feedLink.textContent = config.broadcastify.feedName;
  els.feedLink.href = config.broadcastify.feedUrl;
  els.feedNotes.textContent = config.broadcastify.notes;
  els.modelNotes.textContent = `OpenAI model: ${config.openAiModel}. Public safety delay: ${config.publicSafetyDelayMinutes} min.`;
  els.liveNotes.textContent = config.demoMode
    ? "Current stream is demo data. Add licensed audio or your own scanner feed for real-time transcription."
    : "OpenAI transcription is enabled for uploaded or licensed audio.";
  view.center = config.county.center;

  pixiApp = new PIXI.Application();
  await pixiApp.init({ backgroundAlpha: 0, antialias: true, resizeTo: els.map });
  els.map.appendChild(pixiApp.canvas);
  installMapControls();
  installLiveFeedControls();
  render();

  els.parseButton.addEventListener("click", parseTranscript);
  window.addEventListener("resize", render);
  connectStream();
}

function installLiveFeedControls() {
  const savedUrl = localStorage.getItem("countySignalLiveFeedUrl");
  if (savedUrl) {
    els.liveFeedUrl.value = savedUrl;
  }

  els.loadFeed.addEventListener("click", loadLiveFeed);
  els.startLiveParse.addEventListener("click", startLiveParse);
  els.stopLiveParse.addEventListener("click", stopLiveParse);
  els.liveFeedUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      loadLiveFeed();
    }
  });

  loadLiveFeed();
}

function loadLiveFeed() {
  const url = getValidFeedUrl(els.liveFeedUrl.value);
  if (!url) {
    els.status.textContent = "Enter a valid http or https live feed URL";
    return;
  }

  localStorage.setItem("countySignalLiveFeedUrl", url);
  els.liveFeedFrame.src = url;
  els.openFeed.href = url;
  els.status.textContent = "Live feed player loaded";
}

function getValidFeedUrl(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function installMapControls() {
  els.zoomIn.addEventListener("click", () => setZoom(view.zoom + 1));
  els.zoomOut.addEventListener("click", () => setZoom(view.zoom - 1));
  els.mapLayer.addEventListener("change", () => {
    mapLayer = els.mapLayer.value;
    els.attribution.textContent = tileProviders[mapLayer].attribution;
    renderMap();
  });
  els.resetMap.addEventListener("click", () => {
    view = { center: config.county.center, zoom: 13 };
    renderMap();
  });

  pixiApp.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = pixiApp.canvas.getBoundingClientRect();
    setZoomAtPoint(view.zoom + (event.deltaY < 0 ? 1 : -1), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
  });

  pixiApp.canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    dragStart = { x: event.clientX, y: event.clientY };
    dragCenter = latLngToWorld(view.center, view.zoom);
    pixiApp.canvas.style.cursor = "grabbing";
  });

  pixiApp.canvas.addEventListener("dblclick", (event) => {
    const rect = pixiApp.canvas.getBoundingClientRect();
    setZoomAtPoint(view.zoom + 1, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
  });

  window.addEventListener("pointermove", (event) => {
    if (!dragging || !dragStart || !dragCenter) return;
    const nextWorld = {
      x: dragCenter.x - (event.clientX - dragStart.x),
      y: dragCenter.y - (event.clientY - dragStart.y)
    };
    view.center = worldToLatLng(nextWorld, view.zoom);
    renderMap();
  });

  window.addEventListener("pointerup", () => {
    dragging = false;
    dragStart = null;
    dragCenter = null;
    if (pixiApp) pixiApp.canvas.style.cursor = "grab";
  });

  pixiApp.canvas.style.cursor = "grab";
}

function setZoom(nextZoom) {
  view.zoom = Math.max(10, Math.min(19, nextZoom));
  renderMap();
}

function setZoomAtPoint(nextZoom, screenPoint) {
  const clampedZoom = Math.max(10, Math.min(19, nextZoom));
  if (clampedZoom === view.zoom) return;

  const { width, height } = pixiApp.renderer;
  const oldCenterWorld = latLngToWorld(view.center, view.zoom);
  const focusWorld = {
    x: oldCenterWorld.x + screenPoint.x - width / 2,
    y: oldCenterWorld.y + screenPoint.y - height / 2
  };
  const focusLatLng = worldToLatLng(focusWorld, view.zoom);
  const newFocusWorld = latLngToWorld(focusLatLng, clampedZoom);
  const newCenterWorld = {
    x: newFocusWorld.x - screenPoint.x + width / 2,
    y: newFocusWorld.y - screenPoint.y + height / 2
  };

  view.zoom = clampedZoom;
  view.center = worldToLatLng(newCenterWorld, clampedZoom);
  renderMap();
}

async function parseTranscript() {
  const response = await fetch("/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: els.transcript.value })
  });
  const payload = await response.json();
  addIncident(payload.incident);
}

function connectStream() {
  demoSource = new EventSource("/api/incidents/stream");
  demoSource.addEventListener("incident", (event) => {
    const payload = JSON.parse(event.data);
    addIncident(payload.incident);
    els.status.textContent = "Receiving demo dispatch transcripts";
  });
  demoSource.onerror = () => {
    els.status.textContent = "Demo stream disconnected";
  };
}

async function startLiveParse() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    els.liveParseStatus.textContent = "Browser audio capture is unavailable";
    return;
  }

  try {
    if (demoSource) {
      demoSource.close();
      demoSource = null;
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    const audioTracks = displayStream.getAudioTracks();

    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((track) => track.stop());
      els.liveParseStatus.textContent = "No audio track was shared";
      return;
    }

    const audioStream = new MediaStream(audioTracks);
    const mimeType = getRecorderMimeType();
    const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);

    liveCapture = {
      stream: displayStream,
      recorder,
      busy: false,
      queue: [],
      active: true
    };

    recorder.addEventListener("dataavailable", (event) => {
      if (!liveCapture.active || event.data.size < 1200) return;
      enqueueLiveChunk(event.data);
    });
    recorder.addEventListener("stop", () => {
      liveCapture.active = false;
    });
    displayStream.getTracks().forEach((track) => {
      track.addEventListener("ended", stopLiveParse, { once: true });
    });

    recorder.start(12000);
    els.startLiveParse.disabled = true;
    els.stopLiveParse.disabled = false;
    els.status.textContent = "Live parser running";
    els.liveParseStatus.textContent = "Capturing live audio chunks";
  } catch (error) {
    els.liveParseStatus.textContent = error instanceof Error ? error.message : "Live capture failed";
  }
}

function stopLiveParse() {
  if (liveCapture.recorder?.state && liveCapture.recorder.state !== "inactive") {
    liveCapture.recorder.stop();
  }
  liveCapture.stream?.getTracks().forEach((track) => track.stop());
  liveCapture = {
    stream: null,
    recorder: null,
    busy: false,
    queue: [],
    active: false
  };
  els.startLiveParse.disabled = false;
  els.stopLiveParse.disabled = true;
  els.status.textContent = "Live parser stopped";
  els.liveParseStatus.textContent = "Live parser idle";
}

function getRecorderMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "video/webm;codecs=opus", "video/webm"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function enqueueLiveChunk(blob) {
  liveCapture.queue.push(blob);
  if (liveCapture.queue.length > 4) {
    liveCapture.queue.shift();
  }
  processLiveQueue();
}

async function processLiveQueue() {
  if (liveCapture.busy || liveCapture.queue.length === 0) return;

  liveCapture.busy = true;
  const blob = liveCapture.queue.shift();
  const form = new FormData();
  form.append("audio", blob, "live-dispatch.webm");

  try {
    els.liveParseStatus.textContent = "Transcribing live audio";
    const response = await fetch("/api/transcribe-upload", {
      method: "POST",
      body: form
    });
    const payload = await readApiResponse(response);

    if (!response.ok) {
      throw new Error(payload.error ?? "Transcription failed");
    }

    if (payload.transcript?.trim()) {
      els.transcript.value = payload.transcript.trim();
      addIncident(payload.incident);
      els.liveParseStatus.textContent = "Live transcript plotted";
    } else {
      els.liveParseStatus.textContent = "No speech in latest chunk";
    }
  } catch (error) {
    els.liveParseStatus.textContent = error instanceof Error ? error.message : "Live parse failed";
  } finally {
    liveCapture.busy = false;
    processLiveQueue();
  }
}

async function readApiResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (contentType.includes("application/json")) {
    return JSON.parse(body);
  }

  try {
    return JSON.parse(body);
  } catch {
    const plain = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return {
      error: plain
        ? `Server returned a non-JSON response: ${plain.slice(0, 220)}`
        : "Server returned an empty non-JSON response."
    };
  }
}

function addIncident(incident) {
  incidents = [incident, ...incidents].slice(0, 24);
  render();
}

function render() {
  if (!config || !pixiApp) return;
  renderList();
  renderMap();
}

function renderList() {
  const plotted = incidents.filter((incident) => incident.location);
  els.totalCount.textContent = `${incidents.length} transcripts`;
  els.plottedCount.textContent = `${plotted.length} plotted`;
  els.incidentList.replaceChildren(
    ...incidents.map((incident) => {
      const item = document.createElement("li");
      const head = document.createElement("div");
      const dot = document.createElement("span");
      const address = document.createElement("strong");
      const text = document.createElement("p");
      const time = document.createElement("small");

      dot.className = `dot ${incident.category}`;
      address.textContent = incident.address ?? "No street address found";
      text.textContent = incident.transcript;
      time.textContent = new Date(incident.receivedAt).toLocaleTimeString();

      head.append(dot, address);
      item.append(head, text, time);
      return item;
    })
  );
}

function renderMap() {
  const { width, height } = pixiApp.renderer;
  const overlay = new PIXI.Graphics();

  pixiApp.stage.removeChildren();
  drawTiles(width, height);
  pixiApp.stage.addChild(overlay);
  els.mapStatus.textContent = `${tileProviders[mapLayer].name} · zoom ${view.zoom}`;

  const boundary = config.county.boundary.map(project);
  overlay.poly(boundary).fill({ color: 0x2f6fed, alpha: 0.08 }).stroke({ color: 0x214f7a, width: 3, alpha: 0.9 });

  const center = project(config.county.center);
  const label = new PIXI.Text({
    text: `${config.county.name}, ${config.county.state}`,
    style: { fill: "#28414f", fontFamily: "Arial", fontSize: 18, fontWeight: "700" }
  });
  label.anchor.set(0.5);
  label.position.set(center.x, center.y);
  pixiApp.stage.addChild(label);

  incidents.forEach((incident, index) => {
    if (!incident.location) return;
    const point = project(incident.location);
    const color = categoryColor[incident.category] ?? categoryColor.unknown;
    const marker = new PIXI.Graphics();
    marker.circle(point.x, point.y, 14 + index * 0.4).fill({ color, alpha: 0.22 });
    marker.circle(point.x, point.y, 7).fill(color).stroke({ color: 0xffffff, width: 2 });
    pixiApp.stage.addChild(marker);
  });
}

function drawTiles(width, height) {
  const tileSize = 256;
  const centerWorld = latLngToWorld(view.center, view.zoom);
  const topLeft = {
    x: centerWorld.x - width / 2,
    y: centerWorld.y - height / 2
  };
  const scale = 2 ** view.zoom;
  const minTileX = Math.floor(topLeft.x / tileSize);
  const maxTileX = Math.floor((topLeft.x + width) / tileSize);
  const minTileY = Math.floor(topLeft.y / tileSize);
  const maxTileY = Math.floor((topLeft.y + height) / tileSize);
  const tiles = [];

  for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      if (tileY < 0 || tileY >= scale) continue;
      const wrappedX = ((tileX % scale) + scale) % scale;
      const image = document.createElement("img");
      image.className = "mapTile";
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      image.src = tileProviders[mapLayer].url(view.zoom, wrappedX, tileY);
      image.style.left = `${Math.round(tileX * tileSize - topLeft.x)}px`;
      image.style.top = `${Math.round(tileY * tileSize - topLeft.y)}px`;
      image.addEventListener("error", () => {
        image.style.background = "#d8e1e6";
        image.removeAttribute("src");
      });
      tiles.push(image);
    }
  }

  els.tileLayer.replaceChildren(...tiles);
}

function project(point) {
  const { width, height } = pixiApp.renderer;
  const centerWorld = latLngToWorld(view.center, view.zoom);
  const pointWorld = latLngToWorld(point, view.zoom);
  return {
    x: width / 2 + pointWorld.x - centerWorld.x,
    y: height / 2 + pointWorld.y - centerWorld.y
  };
}

function latLngToWorld(point, zoom) {
  const sinLat = Math.sin((point.lat * Math.PI) / 180);
  const size = 256 * 2 ** zoom;
  return {
    x: ((point.lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * size
  };
}

function worldToLatLng(point, zoom) {
  const size = 256 * 2 ** zoom;
  const lng = (point.x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * point.y) / size;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

boot().catch((error) => {
  els.status.textContent = error.message;
});
