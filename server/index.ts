import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { z } from "zod";
import { extractIncident } from "./lib/addressParser";
import { fetchBroadcastifyFeed } from "./lib/broadcastify";
import { getCountyPreset } from "./lib/counties";
import { transcribeAudioLocally } from "./lib/localTranscription";
import { transcribeAudio } from "./lib/openaiTranscription";

dotenv.config({ override: true });

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 8787);
const compatibilityPort = Number(process.env.COMPATIBILITY_PORT ?? 5173);
const preset = getCountyPreset(process.env.COUNTY_PRESET ?? "greene-oh");
const publicSafetyDelayMinutes = Number(process.env.PUBLIC_SAFETY_DELAY_MINUTES ?? 15);
const transcribeProvider = getTranscribeProvider();
const openAiKeyIssue = transcribeProvider === "openai" ? getOpenAiKeyIssue(process.env.OPENAI_API_KEY) : null;

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
    transcribeProvider,
    localModel: process.env.LOCAL_TRANSCRIBE_MODEL ?? "large-v3-turbo",
    localEngine: "faster-whisper",
    publicSafetyDelayMinutes,
    demoMode: Boolean(openAiKeyIssue),
    openAiKeyConfigured: !openAiKeyIssue,
    openAiKeyIssue
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

  try {
    const transcript =
      transcribeProvider === "local"
        ? await transcribeAudioLocally({
            buffer: req.file.buffer,
            filename: req.file.originalname,
            mimeType: req.file.mimetype
          })
        : await transcribeWithOpenAi(req.file);
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

function getTranscribeProvider(): "openai" | "local" {
  return process.env.TRANSCRIBE_PROVIDER?.toLowerCase() === "local" ? "local" : "openai";
}

function transcribeWithOpenAi(file: Express.Multer.File): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to enable OpenAI transcription, or set TRANSCRIBE_PROVIDER=local.");
  }

  const keyIssue = getOpenAiKeyIssue(process.env.OPENAI_API_KEY);
  if (keyIssue) {
    throw new Error(keyIssue);
  }

  return transcribeAudio({
    apiKey: process.env.OPENAI_API_KEY,
    buffer: file.buffer,
    filename: file.originalname,
    mimeType: file.mimetype,
    model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe"
  });
}

function getOpenAiKeyIssue(value: string | undefined): string | null {
  const key = value?.trim();
  if (!key) {
    return "Set OPENAI_API_KEY in .env to enable live transcription.";
  }

  if (key.startsWith("AIza")) {
    return "OPENAI_API_KEY is set to a Google API key. OpenAI keys start with sk-. Create one at https://platform.openai.com/api-keys.";
  }

  if (key.includes("your-openai-api-key") || key.includes("your-real-openai-key") || key.length < 40) {
    return "OPENAI_API_KEY is still a placeholder or too short. Paste the full OpenAI key from https://platform.openai.com/api-keys.";
  }

  if (!key.startsWith("sk-")) {
    return "OPENAI_API_KEY does not look like an OpenAI API key. OpenAI keys start with sk-.";
  }

  return null;
}
