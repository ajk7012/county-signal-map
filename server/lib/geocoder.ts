import type { CountyPreset, LatLng } from "./counties";

export type GeocodeCandidate = {
  location: LatLng;
  label: string;
  confidence: number;
  source: "arcgis" | "nominatim" | "county-fallback";
  query: string;
  approximate: boolean;
};

const cache = new Map<string, GeocodeCandidate | null>();

export async function geocodeBasicQuery(query: string, county: CountyPreset): Promise<GeocodeCandidate | null> {
  const cleaned = query.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const cacheKey = `${county.id}:${cleaned.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const arcgis = await geocodeArcgis(cleaned, county);
  if (arcgis) {
    cache.set(cacheKey, arcgis);
    return arcgis;
  }

  const nominatim = await geocodeNominatim(cleaned, county);
  cache.set(cacheKey, nominatim);
  return nominatim;
}

export function makeCountyFallback(query: string, county: CountyPreset): GeocodeCandidate {
  const hash = simpleHash(query);

  // Tiny deterministic offset so multiple weak matches do not stack exactly.
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

async function geocodeArcgis(query: string, county: CountyPreset): Promise<GeocodeCandidate | null> {
  const url = new URL("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates");

  url.searchParams.set("f", "json");
  url.searchParams.set("SingleLine", query);
  url.searchParams.set("maxLocations", "10");
  url.searchParams.set("outFields", "Match_addr,Addr_type,Score,City,Region");
  url.searchParams.set("countryCode", "USA");

  // Bias results toward the county.
  url.searchParams.set(
    "searchExtent",
    `${county.bbox.west},${county.bbox.south},${county.bbox.east},${county.bbox.north}`
  );

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      candidates?: Array<{
        address?: string;
        score?: number;
        location?: {
          x?: number;
          y?: number;
        };
        attributes?: {
          Match_addr?: string;
          Addr_type?: string;
          Score?: number;
          City?: string;
          Region?: string;
        };
      }>;
    };

    let bestNear: GeocodeCandidate | null = null;

    for (const candidate of payload.candidates ?? []) {
      const lng = Number(candidate.location?.x);
      const lat = Number(candidate.location?.y);
      const score = Number(candidate.score ?? candidate.attributes?.Score ?? 0);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (score < 45) continue;

      const location = { lat, lng };
      const addrType = candidate.attributes?.Addr_type ?? "";
      const approximate = !/PointAddress|StreetAddress|Subaddress/i.test(addrType);

      const result: GeocodeCandidate = {
        location,
        label: candidate.address ?? candidate.attributes?.Match_addr ?? query,
        confidence: Math.max(0.25, Math.min(0.96, score / 100)),
        source: "arcgis",
        query,
        approximate
      };

      // Strong preference: inside/near county.
      if (insideCountyBox(location, county, 0.06)) {
        return result;
      }

      // Loose nearby fallback.
      if (!bestNear && insideCountyBox(location, county, 0.25)) {
        bestNear = {
          ...result,
          confidence: Math.min(result.confidence, 0.45),
          approximate: true
        };
      }
    }

    return bestNear;
  } catch (error) {
    console.warn("ArcGIS geocode failed:", query, error);
    return null;
  }
}

async function geocodeNominatim(query: string, county: CountyPreset): Promise<GeocodeCandidate | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");

  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "10");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("q", query);

  // Bias around county bbox but do not hard-bound.
  url.searchParams.set("bounded", "0");
  url.searchParams.set("viewbox", `${county.bbox.west},${county.bbox.north},${county.bbox.east},${county.bbox.south}`);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "county-signal-map/0.1 local-development"
      }
    });

    if (!response.ok) return null;

    const results = (await response.json()) as Array<{
      lat: string;
      lon: string;
      display_name?: string;
      importance?: number;
      type?: string;
      class?: string;
    }>;

    let bestNear: GeocodeCandidate | null = null;

    for (const result of results) {
      const location = {
        lat: Number(result.lat),
        lng: Number(result.lon)
      };

      if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) continue;

      const approximate = !/house|residential|address|building/i.test(`${result.type ?? ""} ${result.class ?? ""}`);

      const candidate: GeocodeCandidate = {
        location,
        label: result.display_name ?? query,
        confidence: Math.max(0.25, Math.min(0.85, 0.5 + Number(result.importance ?? 0))),
        source: "nominatim",
        query,
        approximate
      };

      if (insideCountyBox(location, county, 0.06)) {
        return candidate;
      }

      if (!bestNear && insideCountyBox(location, county, 0.25)) {
        bestNear = {
          ...candidate,
          confidence: Math.min(candidate.confidence, 0.42),
          approximate: true
        };
      }
    }

    return bestNear;
  } catch (error) {
    console.warn("Nominatim geocode failed:", query, error);
    return null;
  }
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