import { randomUUID } from "node:crypto";
import type { CountyPreset, LatLng } from "./counties";
import { geocodeBasicQuery, makeCountyFallback, type GeocodeCandidate } from "./geocoder";

export type Incident = {
  id: string;
  transcript: string;
  address: string | null;
  normalizedAddress: string | null;
  location: LatLng | null;
  confidence: number;
  category: "law" | "fire" | "ems" | "traffic" | "unknown";
  receivedAt: string;
  placeName?: string | null;
  geocodeLabel?: string | null;
  geocodeQuery?: string | null;
  geocodeSource?: string | null;
  approximate?: boolean;
};

const streetSuffix =
  "(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|cir|pike|place|pl|highway|hwy|route|rt|terrace|ter|trail|trl|parkway|pkwy)";

const directional = "(?:north|south|east|west|n|s|e|w)";

const addressPattern = new RegExp(
  `\\b\\d{1,6}\\s+[a-z0-9.'-]+(?:\\s+[a-z0-9.'-]+){0,6}\\s+${streetSuffix}\\b(?:\\s+${directional}\\b)?`,
  "i"
);

const roadOnlyPattern = new RegExp(
  `\\b[a-z0-9.'-]+(?:\\s+[a-z0-9.'-]+){0,5}\\s+${streetSuffix}\\b(?:\\s+${directional}\\b)?`,
  "i"
);

export async function extractIncident(transcript: string, county: CountyPreset): Promise<Incident> {
  const cleanedTranscript = cleanTranscript(transcript);

  const address = extractStreetAddress(cleanedTranscript);
  const normalizedAddress = address ? normalizeAddress(address) : null;
  const roadOnly = address ? stripHouseNumber(address) : extractRoadOnly(cleanedTranscript);
  const placeName = extractPlaceName(cleanedTranscript, address);

  const knownLocation = normalizedAddress ? resolveKnownAddress(normalizedAddress, county) : null;

  let geocoded: GeocodeCandidate | null = null;

  if (!knownLocation) {
    const queries = buildSearchQueries({
      transcript: cleanedTranscript,
      address,
      roadOnly,
      placeName,
      county
    });

    geocoded = await geocodeFirstMatch(queries, county);
  }

  // Extremely trigger-happy: if all geocoders fail, still plot an approximate county marker.
  const fallback = knownLocation || geocoded ? null : makeCountyFallback(cleanedTranscript, county);

  const location = knownLocation ?? geocoded?.location ?? fallback?.location ?? null;
  const confidence = knownLocation ? 0.96 : geocoded?.confidence ?? fallback?.confidence ?? 0.05;

  return {
    id: randomUUID(),
    transcript,
    address: address ?? roadOnly ?? placeName ?? cleanedTranscript,
    normalizedAddress: normalizedAddress ?? (roadOnly ? normalizeAddress(roadOnly) : null),
    location,
    confidence,
    category: inferCategory(transcript),
    receivedAt: new Date().toISOString(),
    placeName,
    geocodeLabel: knownLocation ? "Known local address" : geocoded?.label ?? fallback?.label ?? null,
    geocodeQuery: knownLocation ? normalizedAddress : geocoded?.query ?? fallback?.query ?? null,
    geocodeSource: knownLocation ? "knownAddresses" : geocoded?.source ?? fallback?.source ?? null,
    approximate: !knownLocation && (geocoded?.approximate ?? fallback?.approximate ?? true)
  };
}

function cleanTranscript(value: string): string {
  return value
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(AM|PM)\b/gi, "")
    .replace(/\b(?:copy|clear|responding|respond|units?|unit|engine|medic|squad|law|fire|ems)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function extractStreetAddress(transcript: string): string | null {
  const match = transcript.match(addressPattern)?.[0]?.trim() ?? null;
  if (!match) return null;
  return normalizeStreetDisplay(match);
}

function extractRoadOnly(transcript: string): string | null {
  const match = transcript.match(roadOnlyPattern)?.[0]?.trim() ?? null;
  if (!match) return null;

  if (isDispatchNoise(match)) return null;

  return normalizeStreetDisplay(match);
}

function normalizeStreetDisplay(value: string): string {
  return titleCaseAddress(
    value
      .replace(/\bSt\b\.?/gi, "Street")
      .replace(/\bAve\b\.?/gi, "Avenue")
      .replace(/\bRd\b\.?/gi, "Road")
      .replace(/\bDr\b\.?/gi, "Drive")
      .replace(/\bLn\b\.?/gi, "Lane")
      .replace(/\bBlvd\b\.?/gi, "Boulevard")
      .replace(/\bCt\b\.?/gi, "Court")
      .replace(/\bCir\b\.?/gi, "Circle")
      .replace(/\bPl\b\.?/gi, "Place")
      .replace(/\bHwy\b\.?/gi, "Highway")
      .replace(/\bRt\b\.?/gi, "Route")
      .replace(/\bTer\b\.?/gi, "Terrace")
      .replace(/\bTrl\b\.?/gi, "Trail")
      .replace(/\bPkwy\b\.?/gi, "Parkway")
      .replace(/\bN\b\.?$/i, "North")
      .replace(/\bS\b\.?$/i, "South")
      .replace(/\bE\b\.?$/i, "East")
      .replace(/\bW\b\.?$/i, "West")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function titleCaseAddress(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .map((word) => {
      if (/^\d+$/.test(word)) return word;
      if (word === "us") return "US";
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function normalizeAddress(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\b(st|street)\b/g, "street")
    .replace(/\b(ave|avenue)\b/g, "avenue")
    .replace(/\b(rd|road)\b/g, "road")
    .replace(/\b(dr|drive)\b/g, "drive")
    .replace(/\b(ln|lane)\b/g, "lane")
    .replace(/\b(ct|court)\b/g, "court")
    .replace(/\b(blvd|boulevard)\b/g, "boulevard")
    .replace(/\b(cir|circle)\b/g, "circle")
    .replace(/\b(pl|place)\b/g, "place")
    .replace(/\b(hwy|highway)\b/g, "highway")
    .replace(/\b(rt|route)\b/g, "route")
    .replace(/\b(ter|terrace)\b/g, "terrace")
    .replace(/\b(trl|trail)\b/g, "trail")
    .replace(/\b(pkwy|parkway)\b/g, "parkway")
    .replace(/\b(n|north)\b/g, "north")
    .replace(/\b(s|south)\b/g, "south")
    .replace(/\b(e|east)\b/g, "east")
    .replace(/\b(w|west)\b/g, "west")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveKnownAddress(address: string, county: CountyPreset): LatLng | null {
  const direct = county.knownAddresses[address];
  if (direct) return direct;

  const match = Object.entries(county.knownAddresses).find(([known]) => {
    return address.includes(known) || known.includes(address);
  });

  return match?.[1] ?? null;
}

async function geocodeFirstMatch(queries: string[], county: CountyPreset): Promise<GeocodeCandidate | null> {
  for (const query of queries) {
    console.log("Trying geocode:", query);

    const result = await geocodeBasicQuery(query, county);
    if (result) {
      console.log("Geocoded:", query, result);
      return result;
    }
  }

  console.log("No geocode match. Tried:", queries);
  return null;
}

function buildSearchQueries(input: {
  transcript: string;
  address: string | null;
  roadOnly: string | null;
  placeName: string | null;
  county: CountyPreset;
}): string[] {
  const { transcript, address, roadOnly, placeName, county } = input;
  const usefulPhrase = extractUsefulPhrase(transcript, address, placeName);

  const cityHints = [
    "Xenia",
    "Fairborn",
    "Beavercreek",
    "Bellbrook",
    "Yellow Springs",
    "Cedarville",
    "Jamestown",
    "Spring Valley",
    "Wilberforce",
    "Wright-Patterson AFB",
    "Bowersville",
    "Clifton",
    "Alpha",
    "Riverside",
    "Dayton",
    "Sugarcreek Township",
    "Bath Township",
    "Miami Township",
    "Caesarscreek Township",
    "Xenia Township"
  ];

  const queries: Array<string | null> = [];

  if (address) {
    queries.push(`${address}, ${county.name}, ${county.state}`);
    queries.push(`${address}, Ohio`);

    for (const city of cityHints) {
      queries.push(`${address}, ${city}, ${county.state}`);
    }
  }

  if (roadOnly) {
    queries.push(`${roadOnly}, ${county.name}, ${county.state}`);
    queries.push(`${roadOnly}, Ohio`);

    for (const city of cityHints) {
      queries.push(`${roadOnly}, ${city}, ${county.state}`);
    }
  }

  if (placeName) {
    queries.push(`${placeName}, ${county.name}, ${county.state}`);
    queries.push(`${placeName}, Ohio`);

    for (const city of cityHints) {
      queries.push(`${placeName}, ${city}, ${county.state}`);
    }
  }

  if (usefulPhrase) {
    queries.push(`${usefulPhrase}, ${county.name}, ${county.state}`);
    queries.push(`${usefulPhrase}, Ohio`);
  }

  // Last broad attempt before fallback.
  queries.push(`${transcript}, ${county.name}, ${county.state}`);

  return [...new Set(queries.filter(Boolean).map((query) => query.trim()).filter(Boolean) as string[])];
}

function extractPlaceName(transcript: string, address: string | null): string | null {
  let text = transcript;

  if (address) {
    text = text.replace(new RegExp(escapeRegExp(address), "i"), "");
  }

  const parts = text
    .split(",")
    .map((part) => part.trim().replace(/\.$/, ""))
    .filter(Boolean)
    .filter((part) => !/\b\d{1,6}\s+\w+/.test(part))
    .filter((part) => !isDispatchNoise(part));

  if (parts.length === 0) return null;

  parts.sort((a, b) => a.length - b.length);
  return titleCaseAddress(parts[0]);
}

function extractUsefulPhrase(transcript: string, address: string | null, placeName: string | null): string | null {
  if (placeName) return placeName;
  if (address) return address;

  const text = transcript
    .replace(/\b(unit|respond|responding|requested|caller|reports?|for|at|near|to|on|in)\b/gi, " ")
    .replace(/\b(medic|ems|squad|ambulance|sheriff|police|pd|fire|traffic|crash|disturbance)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length >= 4 ? titleCaseAddress(text) : null;
}

function stripHouseNumber(address: string): string | null {
  const road = address.replace(/^\s*\d{1,6}\s+/, "").trim();
  return road.length >= 3 ? road : null;
}

function isDispatchNoise(value: string): boolean {
  return /\b(unit|respond|responding|medic|sheriff|police|pd|fire|ems|caller|requested|welfare|disturbance|crash|accident|traffic|copy|clear)\b/i.test(
    value
  );
}

function inferCategory(transcript: string): Incident["category"] {
  const text = transcript.toLowerCase();
  if (/\b(medic|ems|squad|ambulance|medical|advanced care|difficulty breathing|chest pain)\b/.test(text)) return "ems";
  if (/\b(fire|smoke|alarm|flames|structure fire|brush fire)\b/.test(text)) return "fire";
  if (/\b(crash|accident|traffic|injury crash|vehicle)\b/.test(text)) return "traffic";
  if (/\b(sheriff|pd|police|unit|disturbance|welfare|domestic|theft|suspicious)\b/.test(text)) return "law";
  return "unknown";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}