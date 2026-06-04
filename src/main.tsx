import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as PIXI from "pixi.js";
import "./styles.css";

type LatLng = { lat: number; lng: number };
type CountyConfig = {
  county: {
    name: string;
    state: string;
    center: LatLng;
    bbox: { west: number; south: number; east: number; north: number };
    boundary: LatLng[];
  };
  broadcastify: {
    feedId: string;
    countyPage: string;
    feedName: string;
    feedUrl: string;
    notes: string;
  };
  openAiModel: string;
  publicSafetyDelayMinutes: number;
  demoMode: boolean;
};
type Incident = {
  id: string;
  transcript: string;
  address: string | null;
  location: LatLng | null;
  confidence: number;
  category: "law" | "fire" | "ems" | "traffic" | "unknown";
  receivedAt: string;
};

const categoryColor: Record<Incident["category"], number> = {
  law: 0x2f6fed,
  fire: 0xe4572e,
  ems: 0x2fbf71,
  traffic: 0xf4a261,
  unknown: 0x6f7d8c
};

function App() {
  const [config, setConfig] = useState<CountyConfig | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [transcript, setTranscript] = useState("Unit 12 respond to 69 West Hebble Avenue in Fairborn for a disturbance.");
  const [status, setStatus] = useState("Connecting to local demo stream");

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then(setConfig)
      .catch(() => setStatus("API is not reachable"));
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/incidents/stream");
    source.addEventListener("incident", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { incident: Incident };
      setIncidents((items) => [payload.incident, ...items].slice(0, 24));
      setStatus("Receiving demo dispatch transcripts");
    });
    source.onerror = () => setStatus("Demo stream disconnected");
    return () => source.close();
  }, []);

  async function parseTranscript() {
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript })
    });
    const payload = (await response.json()) as { incident: Incident };
    setIncidents((items) => [payload.incident, ...items].slice(0, 24));
  }

  const plotted = useMemo(() => incidents.filter((incident) => incident.location), [incidents]);

  return (
    <main>
      <section className="shell">
        <div className="mapPane">
          {config ? <PixiCountyMap config={config} incidents={plotted} /> : <div className="loading">Loading map</div>}
        </div>
        <aside className="sidePanel">
          <div className="masthead">
            <span>{config?.county.name ?? "County"} Signal Map</span>
            <strong>{status}</strong>
          </div>

          {config && (
            <div className="feedBox">
              <div>
                <small>Broadcastify target</small>
                <a href={config.broadcastify.feedUrl} target="_blank" rel="noreferrer">
                  {config.broadcastify.feedName}
                </a>
              </div>
              <p>{config.broadcastify.notes}</p>
              <small>
                Uses licensed/uploaded audio for transcription. OpenAI model: {config.openAiModel}. Public safety delay:{" "}
                {config.publicSafetyDelayMinutes} min.
              </small>
            </div>
          )}

          <div className="parserBox">
            <textarea value={transcript} onChange={(event) => setTranscript(event.target.value)} />
            <button onClick={parseTranscript}>Parse transcript</button>
          </div>

          <div className="stats">
            <span>{incidents.length} transcripts</span>
            <span>{plotted.length} plotted</span>
          </div>

          <ol className="incidentList">
            {incidents.map((incident) => (
              <li key={incident.id}>
                <div>
                  <span className={`dot ${incident.category}`} />
                  <strong>{incident.address ?? "No street address found"}</strong>
                </div>
                <p>{incident.transcript}</p>
                <small>{new Date(incident.receivedAt).toLocaleTimeString()}</small>
              </li>
            ))}
          </ol>
        </aside>
      </section>
    </main>
  );
}

function PixiCountyMap({ config, incidents }: { config: CountyConfig; incidents: Incident[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const app = new PIXI.Application();
    let cancelled = false;

    app.init({ background: "#eef3f5", antialias: true, resizeTo: hostRef.current }).then(() => {
      if (cancelled || !hostRef.current) return;

      hostRef.current.appendChild(app.canvas);
      drawMap(app, config, incidents);
    });

    return () => {
      cancelled = true;
      app.destroy(true, { children: true });
    };
  }, [config, incidents]);

  return <div ref={hostRef} className="pixiHost" />;
}

function drawMap(app: PIXI.Application, config: CountyConfig, incidents: Incident[]) {
  const { width, height } = app.renderer;
  const padding = Math.min(width, height) * 0.09;
  const project = (point: LatLng) => {
    const { west, east, north, south } = config.county.bbox;
    return {
      x: padding + ((point.lng - west) / (east - west)) * (width - padding * 2),
      y: padding + ((north - point.lat) / (north - south)) * (height - padding * 2)
    };
  };

  const g = new PIXI.Graphics();
  app.stage.addChild(g);

  g.rect(0, 0, width, height).fill(0xeef3f5);

  for (let i = 0; i < 8; i += 1) {
    const x = padding + (i / 7) * (width - padding * 2);
    g.moveTo(x, padding).lineTo(x, height - padding).stroke({ color: 0xd3dde4, width: 1 });
  }
  for (let i = 0; i < 6; i += 1) {
    const y = padding + (i / 5) * (height - padding * 2);
    g.moveTo(padding, y).lineTo(width - padding, y).stroke({ color: 0xd3dde4, width: 1 });
  }

  const boundary = config.county.boundary.map(project);
  g.poly(boundary).fill(0xf8faf9).stroke({ color: 0x2c4c5f, width: 3 });

  const center = project(config.county.center);
  const label = new PIXI.Text({
    text: `${config.county.name}, ${config.county.state}`,
    style: { fill: "#28414f", fontFamily: "Arial", fontSize: 18, fontWeight: "700" }
  });
  label.anchor.set(0.5);
  label.position.set(center.x, center.y);
  app.stage.addChild(label);

  incidents.forEach((incident, index) => {
    if (!incident.location) return;
    const point = project(incident.location);
    const pulse = new PIXI.Graphics();
    const color = categoryColor[incident.category];
    pulse.circle(point.x, point.y, 14 + index * 0.4).fill({ color, alpha: 0.15 });
    pulse.circle(point.x, point.y, 7).fill(color).stroke({ color: 0xffffff, width: 2 });
    app.stage.addChild(pulse);
  });
}

createRoot(document.getElementById("root")!).render(<App />);
