export type BroadcastifyFeedDetails = {
  source: "configured" | "api";
  data: unknown;
};

export async function fetchBroadcastifyFeed(feedId: string): Promise<BroadcastifyFeedDetails> {
  const key = process.env.BROADCASTIFY_API_KEY;
  if (!key) {
    return {
      source: "configured",
      data: {
        feedId,
        message: "Set BROADCASTIFY_API_KEY to query the approved Broadcastify catalog API."
      }
    };
  }

  const url = new URL("https://api.broadcastify.com/audio/");
  url.searchParams.set("a", "feed");
  url.searchParams.set("feedId", feedId);
  url.searchParams.set("type", "json");
  url.searchParams.set("key", key);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Broadcastify API returned ${response.status}`);
  }

  return {
    source: "api",
    data: await response.json()
  };
}
