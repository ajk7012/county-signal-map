import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type LocalTranscribeOptions = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

export async function transcribeAudioLocally(options: LocalTranscribeOptions): Promise<string> {
  const tempDir = path.join(os.tmpdir(), "county-signal-map");
  await mkdir(tempDir, { recursive: true });

  const audioPath = path.join(tempDir, `audio-${Date.now()}-${Math.random().toString(16).slice(2)}${getExtension(options)}`);
  await writeFile(audioPath, options.buffer);

  try {
    const result = await runLocalTranscriber(audioPath);
    if (result.error) {
      throw new Error(result.error);
    }

    return result.transcript?.trim() ?? "";
  } finally {
    await rm(audioPath, { force: true });
  }
}

function runLocalTranscriber(audioPath: string): Promise<{ transcript?: string; error?: string }> {
  const python = process.env.LOCAL_TRANSCRIBE_PYTHON ?? "python";
  const scriptPath = path.resolve("scripts/local_transcribe.py");
  const args = [
    scriptPath,
    audioPath,
    "--model",
    process.env.LOCAL_TRANSCRIBE_MODEL ?? "large-v3-turbo",
    "--device",
    process.env.LOCAL_TRANSCRIBE_DEVICE ?? "auto",
    "--compute-type",
    process.env.LOCAL_TRANSCRIBE_COMPUTE_TYPE ?? "default",
    "--language",
    process.env.LOCAL_TRANSCRIBE_LANGUAGE ?? "en"
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: process.cwd(),
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`Local transcription could not start Python command "${python}". Set LOCAL_TRANSCRIBE_PYTHON in .env.`));
        return;
      }

      reject(error);
    });
    child.on("close", (code) => {
      const parsed = parseJson(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }

      resolve({
        error: `Local transcription failed with exit code ${code}. ${stderr || stdout || "No output."}`.trim()
      });
    });
  });
}

function parseJson(value: string): { transcript?: string; error?: string } | null {
  const text = value.trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as { transcript?: string; error?: string };
  } catch {
    return null;
  }
}

function getExtension(options: LocalTranscribeOptions): string {
  const filenameExtension = path.extname(options.filename);
  if (filenameExtension) {
    return filenameExtension;
  }

  if (options.mimeType.includes("webm")) return ".webm";
  if (options.mimeType.includes("wav")) return ".wav";
  if (options.mimeType.includes("mpeg") || options.mimeType.includes("mp3")) return ".mp3";
  if (options.mimeType.includes("mp4")) return ".mp4";
  if (options.mimeType.includes("ogg")) return ".ogg";
  return ".audio";
}
