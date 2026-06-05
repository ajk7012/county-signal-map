import https from "node:https";
import type { CountyPreset, LatLng } from "./counties";

export type GeocodeCandidate = {
  location: LatLng;
  label: string;
  confidence: number;
  source: "nominatim" | "county-fallback";
  query: string;
  approximate: boolean;
};

type NominatimResult = {
  lat: string;
  lon: string;
  display_name?: string;
  importance?: number;
  type?: string;
  class?: string;
  addresstype?: string;
};

const cache = new Map<string, GeocodeCandidate | null>();
let lastRequestAt = 0;

export async function geocodeBasicQuery(query: string, county: CountyPreset): Promise<GeocodeCandidate | null> {
  const cleaned = query.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const cacheKey = `${county.id}:${cleaned.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const bounded = await geocodeNominatim(cleaned, county, true);
  if (bounded) {
    cache.set(cacheKey, bounded);
    return bounded;
  }

  if (process.env.GEOCODER_UNBOUNDED_FALLBACK !== "true") {
    cache.set(cacheKey, null);
    return null;
  }

  const unbounded = await geocodeNominatim(cleaned, county, false);
  cache.set(cacheKey, unbounded);
  return unbounded;
}

export function makeCountyFallback(query: string, county: CountyPreset): GeocodeCandidate {
  const hash = simpleHash(query);

  const latOffset = ((hash % 300) - 150) / 100000;
  const lngOffset = (((hash >> 8) % 300) - 150) / 100000;

  return {
    location: {
      lat: county.center.lat + latOffset,
      lng: county.center.lng + lngOffset
    },
    label: `Approximate fallback near ${county.name}, ${county.state}`,
    confidence: 0.1,
    source: "county-fallback",
    query,
    approximate: true
  };
}

async function geocodeNominatim(query: string, county: CountyPreset, bounded: boolean): Promise<GeocodeCandidate | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");

  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "8");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("dedupe", "1");
  url.searchParams.set("q", query);
  url.searchParams.set("viewbox", `${county.bbox.west},${county.bbox.north},${county.bbox.east},${county.bbox.south}`);
  url.searchParams.set("bounded", bounded ? "1" : "0");

  try {
    await respectNominatimPace();

    const results = await requestJson<NominatimResult[]>(url);
    const candidates = results
      .map((result) => toCandidate(result, query, county))
      .filter((candidate): candidate is GeocodeCandidate => Boolean(candidate))
      .sort((a, b) => b.confidence - a.confidence);

    const strict = candidates.find((candidate) => insideCountyBox(candidate.location, county, 0.02));
    if (strict) return strict;

    const near = candidates.find((candidate) => insideCountyBox(candidate.location, county, 0.25));
    return near
      ? {
          ...near,
          confidence: Math.min(near.confidence, 0.55),
          approximate: true
        }
      : null;
  } catch (error) {
    console.warn("Nominatim geocode failed:", query, error);
    return null;
  }
}

function toCandidate(result: NominatimResult, query: string, county: CountyPreset): GeocodeCandidate | null {
  const location = {
    lat: Number(result.lat),
    lng: Number(result.lon)
  };

  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return null;
  }

  const kind = `${result.type ?? ""} ${result.class ?? ""} ${result.addresstype ?? ""}`;
  const addressLike = /\b(house|residential|address|building|yes|apartments)\b/i.test(kind);
  const roadLike = /\b(road|street|tertiary|secondary|residential)\b/i.test(kind);
  const inCounty = insideCountyBox(location, county, 0.02);
  const nearCounty = insideCountyBox(location, county, 0.25);

  let confidence = 0.45 + Number(result.importance ?? 0);
  if (addressLike) confidence += 0.22;
  if (roadLike) confidence += 0.12;
  if (inCounty) confidence += 0.22;
  else if (nearCounty) confidence += 0.05;
  else confidence -= 0.4;

  return {
    location,
    label: result.display_name ?? query,
    confidence: Math.max(0.15, Math.min(0.96, confidence)),
    source: "nominatim",
    query,
    approximate: !addressLike
  };
}

function requestJson<T>(url: URL): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        rejectUnauthorized: shouldVerifyTls(),
        headers: {
          Accept: "application/json",
          "User-Agent": "county-signal-map/0.1 local-development"
        }
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`OpenStreetMap geocoder returned ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }

          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", (error: NodeJS.ErrnoException) => {
      if (isCertificateError(error)) {
        reject(
          new Error(
            "OpenStreetMap TLS certificate verification failed. Set GEOCODER_ALLOW_INSECURE_TLS=true for local testing or configure NODE_EXTRA_CA_CERTS."
          )
        );
        return;
      }

      reject(error);
    });
    req.setTimeout(Number(process.env.GEOCODER_REQUEST_TIMEOUT_MS ?? 3500), () => {
      req.destroy(new Error("OpenStreetMap geocoder request timed out."));
    });
    req.end();
  });
}

async function respectNominatimPace(): Promise<void> {
  const minGapMs = Number(process.env.NOMINATIM_MIN_INTERVAL_MS ?? 1100);
  const waitMs = lastRequestAt + minGapMs - Date.now();

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  lastRequestAt = Date.now();
}

function shouldVerifyTls(): boolean {
  if (process.env.GEOCODER_ALLOW_INSECURE_TLS === "true") return false;
  if (process.env.OPENAI_ALLOW_INSECURE_TLS === "true") return false;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return false;
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

function insideCountyBox(point: LatLng, county: CountyPreset, padding: number): boolean {
  return (
    point.lng >= county.bbox.west - padding &&
    point.lng <= county.bbox.east + padding &&
    point.lat >= county.bbox.south - padding &&
    point.lat <= county.bbox.north + padding
  );
}

function simpleHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
