import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { z } from "zod";
import { extractIncident } from "./lib/addressParser";
import { fetchBroadcastifyFeed } from "./lib/broadcastify";
import { getCountyPreset } from "./lib/counties";
import { transcribeAudio } from "./lib/openaiTranscription";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 8787);
const compatibilityPort = Number(process.env.COMPATIBILITY_PORT ?? 5173);
const preset = getCountyPreset(process.env.COUNTY_PRESET ?? "greene-oh");
const publicSafetyDelayMinutes = Number(process.env.PUBLIC_SAFETY_DELAY_MINUTES ?? 15);

app.use(cors());
app.use(express.json());
app.use(
  express.static("public", {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store");
    }
  })
);
app.get("/vendor/pixi.mjs", (_req, res) => {
  res.sendFile(path.resolve("node_modules/pixi.js/dist/pixi.mjs"));
});

app.get("/api/config", (_req, res) => {
  res.json({
    county: preset,
    broadcastify: preset.broadcastify,
    openAiModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe",
    publicSafetyDelayMinutes,
    demoMode: !process.env.OPENAI_API_KEY
  });
});

const transcriptSchema = z.object({
  transcript: z.string().min(1)
});

app.post("/api/parse", (req, res) => {
  const parsed = transcriptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Expected { transcript: string }." });
    return;
  }

  const incident = extractIncident(parsed.data.transcript, preset);
  res.json({ incident });
});

app.get("/api/broadcastify/feed", async (_req, res) => {
  try {
    const feed = await fetchBroadcastifyFeed(preset.broadcastify.feedId);
    res.json(feed);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Broadcastify lookup failed." });
  }
});

app.post("/api/transcribe-upload", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Upload an audio file in the 'audio' field." });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(400).json({ error: "Set OPENAI_API_KEY to enable transcription." });
    return;
  }

  try {
    const transcript = await transcribeAudio({
      apiKey: process.env.OPENAI_API_KEY,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe"
    });
    const incident = extractIncident(transcript, preset);
    res.json({ transcript, incident });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Transcription failed." });
  }
});

app.get("/api/incidents/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const samples = [
    "Unit 12 respond to 69 West Hebble Avenue in Fairborn for a disturbance.",
    "Medic and sheriff requested near 100 Dayton Street, Yellow Springs for a welfare check.",
    "Xenia PD traffic crash at 101 North Detroit Street.",
    "Report of smoke near 60 South Charleston Road in Cedarville.",
    "Caller reports a suspicious vehicle at 20 West Main Street, Jamestown."
  ];

  let index = 0;
  const sendIncident = () => {
    const transcript = samples[index % samples.length];
    index += 1;
    const incident = extractIncident(transcript, preset);
    res.write(`event: incident\n`);
    res.write(`data: ${JSON.stringify({ incident })}\n\n`);
  };

  sendIncident();
  const timer = setInterval(sendIncident, 8000);
  req.on("close", () => clearInterval(timer));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: error instanceof Error ? error.message : "Server error." });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`County Signal Map listening on http://127.0.0.1:${port}`);
});

if (compatibilityPort !== port) {
  app.listen(compatibilityPort, "127.0.0.1", () => {
    console.log(`County Signal Map compatibility URL listening on http://127.0.0.1:${compatibilityPort}`);
  });
}
