import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type LocalTranscribeOptions = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

type WorkerResult = {
  transcript?: string;
  error?: string;
};

type PendingRequest = {
  audioPath: string;
  resolve: (value: WorkerResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady: Promise<void> | null = null;
let workerBuffer = "";
let workerLoadError: string | null = null;
let workerRequestId = 0;
const pendingRequests = new Map<string, PendingRequest>();

export async function transcribeAudioLocally(options: LocalTranscribeOptions): Promise<string> {
  const tempDir = path.join(os.tmpdir(), "county-signal-map");
  await mkdir(tempDir, { recursive: true });

  const audioPath = path.join(tempDir, `audio-${Date.now()}-${Math.random().toString(16).slice(2)}${getExtension(options)}`);
  await writeFile(audioPath, options.buffer);

  try {
    const result = await runLocalWorker(audioPath);
    if (result.error) {
      throw new Error(result.error);
    }

    return result.transcript?.trim() ?? "";
  } finally {
    await rm(audioPath, { force: true });
  }
}

async function runLocalWorker(audioPath: string): Promise<WorkerResult> {
  await ensureWorkerReady();

  if (!worker?.stdin.writable) {
    resetWorker();
    throw new Error("Local transcription worker is not writable. Try again after the worker restarts.");
  }

  const id = String(++workerRequestId);
  const timeoutMs = Number(process.env.LOCAL_TRANSCRIBE_TIMEOUT_MS ?? 120000);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      resetWorker();
      reject(new Error(`Local transcription timed out after ${Math.round(timeoutMs / 1000)} seconds. Try LOCAL_TRANSCRIBE_MODEL=small.en or use TRANSCRIBE_PROVIDER=openai for live parsing.`));
    }, timeoutMs);

    pendingRequests.set(id, {
      audioPath,
      resolve,
      reject,
      timeout
    });

    worker!.stdin.write(`${JSON.stringify({ id, audioPath })}\n`);
  });
}

async function ensureWorkerReady(): Promise<void> {
  if (workerReady) {
    return workerReady;
  }

  const python = process.env.LOCAL_TRANSCRIBE_PYTHON ?? "python";
  const scriptPath = path.resolve("scripts/local_transcribe_worker.py");
  const args = [
    scriptPath,
    "--model",
    process.env.LOCAL_TRANSCRIBE_MODEL ?? "large-v3-turbo",
    "--device",
    process.env.LOCAL_TRANSCRIBE_DEVICE ?? "auto",
    "--compute-type",
    process.env.LOCAL_TRANSCRIBE_COMPUTE_TYPE ?? "default",
    "--language",
    process.env.LOCAL_TRANSCRIBE_LANGUAGE ?? "en"
  ];

  workerReady = new Promise((resolve, reject) => {
    workerLoadError = null;
    worker = spawn(python, args, {
      cwd: process.cwd(),
      windowsHide: true
    });

    let stderr = "";

    const loadTimeout = setTimeout(() => {
      resetWorker();
      reject(new Error("Local transcription model is still loading. The first run may need to download the model; if it stays stuck, use LOCAL_TRANSCRIBE_MODEL=small.en for live parsing."));
    }, Number(process.env.LOCAL_TRANSCRIBE_LOAD_TIMEOUT_MS ?? 300000));

    worker.stdout.on("data", (chunk) => {
      workerBuffer += chunk.toString();
      drainWorkerLines((message) => {
        if (message.type === "loading") {
          return;
        }

        if (message.type === "ready") {
          clearTimeout(loadTimeout);
          if (message.error) {
            workerLoadError = message.error;
            reject(new Error(message.error));
            return;
          }

          resolve();
          return;
        }

        if (message.type === "result") {
          handleWorkerResult(message);
        }
      });
    });

    worker.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    worker.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(loadTimeout);
      if (error.code === "ENOENT") {
        reject(new Error(`Local transcription could not start Python command "${python}". Set LOCAL_TRANSCRIBE_PYTHON in .env.`));
        return;
      }

      reject(error);
    });

    worker.on("close", (code) => {
      clearTimeout(loadTimeout);
      const error = new Error(`Local transcription worker exited with code ${code}. ${stderr || workerLoadError || "No output."}`.trim());
      for (const request of pendingRequests.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      pendingRequests.clear();
      resetWorker();
      reject(error);
    });
  });

  return workerReady;
}

function drainWorkerLines(onMessage: (message: any) => void): void {
  let newlineIndex = workerBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = workerBuffer.slice(0, newlineIndex).trim();
    workerBuffer = workerBuffer.slice(newlineIndex + 1);
    if (line) {
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Ignore non-JSON output from Python libraries.
      }
    }
    newlineIndex = workerBuffer.indexOf("\n");
  }
}

function handleWorkerResult(message: { id?: string; transcript?: string; error?: string }): void {
  if (!message.id) {
    return;
  }

  const request = pendingRequests.get(message.id);
  if (!request) {
    return;
  }

  pendingRequests.delete(message.id);
  clearTimeout(request.timeout);
  request.resolve({
    transcript: message.transcript,
    error: message.error
  });
}

function resetWorker(): void {
  if (worker) {
    worker.kill();
  }
  worker = null;
  workerReady = null;
  workerBuffer = "";
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
