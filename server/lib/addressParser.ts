import type { CountyPreset, LatLng } from "./counties";
import { randomUUID } from "node:crypto";

export type Incident = {
  id: string;
  transcript: string;
  address: string | null;
  normalizedAddress: string | null;
  location: LatLng | null;
  confidence: number;
  category: "law" | "fire" | "ems" | "traffic" | "unknown";
  receivedAt: string;
};

const streetSuffix = "(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|cir|pike)";
const addressPattern = new RegExp(
  `\\b\\d{1,6}\\s+[a-z0-9.'-]+(?:\\s+[a-z0-9.'-]+){0,4}\\s+${streetSuffix}\\b(?:\\s*(?:in|,)?\\s*[a-z\\s]+)?`,
  "i"
);

export function extractIncident(transcript: string, county: CountyPreset): Incident {
  const address = transcript.match(addressPattern)?.[0]?.trim() ?? null;
  const normalizedAddress = address ? normalizeAddress(address) : null;
  const location = normalizedAddress ? resolveKnownAddress(normalizedAddress, county) : null;

  return {
    id: randomUUID(),
    transcript,
    address,
    normalizedAddress,
    location,
    confidence: location ? 0.92 : address ? 0.55 : 0.2,
    category: inferCategory(transcript),
    receivedAt: new Date().toISOString()
  };
}

function normalizeAddress(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\b(st|street)\b/g, "street")
    .replace(/\b(ave|avenue)\b/g, "avenue")
    .replace(/\b(rd|road)\b/g, "road")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveKnownAddress(address: string, county: CountyPreset): LatLng | null {
  const direct = county.knownAddresses[address];
  if (direct) {
    return direct;
  }

  const match = Object.entries(county.knownAddresses).find(([known]) => {
    return address.includes(known) || known.includes(address);
  });

  return match?.[1] ?? null;
}

function inferCategory(transcript: string): Incident["category"] {
  const text = transcript.toLowerCase();
  if (/\b(medic|ems|squad|ambulance)\b/.test(text)) return "ems";
  if (/\b(fire|smoke|alarm)\b/.test(text)) return "fire";
  if (/\b(crash|accident|traffic)\b/.test(text)) return "traffic";
  if (/\b(sheriff|pd|police|unit|disturbance|welfare)\b/.test(text)) return "law";
  return "unknown";
}
