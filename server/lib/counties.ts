export type LatLng = {
  lat: number;
  lng: number;
};

export type CountyPreset = {
  id: string;
  name: string;
  state: string;
  center: LatLng;
  bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  boundary: LatLng[];
  knownAddresses: Record<string, LatLng>;
  broadcastify: {
    feedId: string;
    countyPage: string;
    feedName: string;
    feedUrl: string;
    notes: string;
  };
};

const greeneOh: CountyPreset = {
  id: "greene-oh",
  name: "Greene County",
  state: "Ohio",
  center: { lat: 39.6908, lng: -83.8949 },
  bbox: { west: -84.09, south: 39.53, east: -83.62, north: 39.82 },
  boundary: [
    { lat: 39.8205, lng: -84.045 },
    { lat: 39.815, lng: -83.625 },
    { lat: 39.705, lng: -83.628 },
    { lat: 39.531, lng: -83.733 },
    { lat: 39.541, lng: -84.059 },
    { lat: 39.8205, lng: -84.045 }
  ],
  knownAddresses: {
    "69 west hebble avenue fairborn": { lat: 39.8222, lng: -84.0232 },
    "100 dayton street yellow springs": { lat: 39.8071, lng: -83.8873 },
    "101 north detroit street xenia": { lat: 39.6849, lng: -83.9296 },
    "60 south charleston road cedarville": { lat: 39.7423, lng: -83.8089 },
    "20 west main street jamestown": { lat: 39.6583, lng: -83.7355 }
  },
  broadcastify: {
    feedId: "33333",
    countyPage: "https://www.broadcastify.com/listen/ctid/2068",
    feedName: "Central and Eastern Greene County Public Safety",
    feedUrl: "https://www.broadcastify.com/listen/feed/33333",
    notes:
      "Includes law enforcement, fire, EMS, Xenia PD/FD, Greene County Sheriff, Yellow Springs, Cedarville, Jamestown, and Spring Valley."
  }
};

export function getCountyPreset(id: string): CountyPreset {
  if (id !== "greene-oh") {
    return greeneOh;
  }

  return greeneOh;
}
