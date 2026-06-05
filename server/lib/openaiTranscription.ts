import https from "node:https";

type TranscribeAudioOptions = {
  apiKey: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  model: string;
};

export async function transcribeAudio(options: TranscribeAudioOptions): Promise<string> {
  const boundary = `county-signal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    fieldPart(boundary, "model", options.model),
    fieldPart(boundary, "response_format", "text"),
    filePart(boundary, "file", options.filename, options.mimeType, options.buffer),
    Buffer.from(`--${boundary}--\r\n`)
  ]);

  const response = await requestOpenAi(body, boundary, options.apiKey);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(parseOpenAiError(response.body) ?? `OpenAI transcription failed with ${response.statusCode}`);
  }

  return response.body.trim();
}

function fieldPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}

function filePart(boundary: string, name: string, filename: string, mimeType: string, buffer: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`
    ),
    buffer,
    Buffer.from("\r\n")
  ]);
}

function requestOpenAi(
  body: Buffer,
  boundary: string,
  apiKey: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        method: "POST",
        rejectUnauthorized: shouldVerifyOpenAiTls(),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    req.on("error", (error: NodeJS.ErrnoException) => {
      if (isCertificateError(error)) {
        reject(
          new Error(
            "OpenAI TLS certificate verification failed. For this local app, set OPENAI_ALLOW_INSECURE_TLS=true in .env and restart, or configure NODE_EXTRA_CA_CERTS with your local root certificate."
          )
        );
        return;
      }

      reject(error);
    });
    req.write(body);
    req.end();
  });
}

function shouldVerifyOpenAiTls(): boolean {
  if (process.env.OPENAI_ALLOW_INSECURE_TLS === "true") {
    return false;
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    return false;
  }

  return true;
}

function isCertificateError(error: NodeJS.ErrnoException): boolean {
  return (
    error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    error.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    error.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    /unable to verify the first certificate|certificate verify failed/i.test(error.message)
  );
}

function parseOpenAiError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? null;
  } catch {
    return body.trim().slice(0, 300) || null;
  }
}
