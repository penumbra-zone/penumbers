import type { Metadata } from "@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb";

const COINGECKO_CACHE_TTL_MS = 60 * 1000 * 10; // ten minutes

// Small cache-aside layer for coin gecko (guecko? gekko?) prices.
interface CacheEntry {
  value: number | undefined;
  expiry: number;
}

const coinGeckoCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<number | undefined>>();

// We only block if the cache is empty.
// We only make one request per asset at a time.
export async function fetchCoinGeckoPrice(
  metadata: Metadata
): Promise<number | undefined> {
  const coinGeckoId = metadata.coingeckoId || metadata.symbol;
  if (!coinGeckoId) return undefined;

  const now = Date.now();
  const cached = coinGeckoCache.get(coinGeckoId);
  if (cached && cached.expiry > now) {
    return cached.value;
  }

  if (inFlightRequests.has(coinGeckoId)) {
    return await inFlightRequests.get(coinGeckoId)!;
  }

  const promise = fetchAndCacheCoinGeckoPrice(coinGeckoId);
  inFlightRequests.set(coinGeckoId, promise);

  try {
    const price = await promise;
    return price;
  } finally {
    inFlightRequests.delete(coinGeckoId);
  }
}

async function fetchAndCacheCoinGeckoPrice(
  coinGeckoId: string
): Promise<number | undefined> {
  const now = Date.now();
  try {
    const response = await fetch(
      `https://pro-api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd&x_cg_pro_api_key=${process.env.COINGECKO_API_KEY}`
    );
    if (!response.ok) {
      console.error(
        `Failed to fetch CoinGecko price for ${coinGeckoId}, status: ${response.status}`
      );
      coinGeckoCache.set(coinGeckoId, {
        value: undefined,
        expiry: now + COINGECKO_CACHE_TTL_MS,
      });
      return undefined;
    }
    const data = await response.json();
    const price = data[coinGeckoId]?.usd;
    coinGeckoCache.set(coinGeckoId, {
      value: price,
      expiry: now + COINGECKO_CACHE_TTL_MS,
    });
    return price;
  } catch (error) {
    console.error(`Error fetching CoinGecko price for ${coinGeckoId}:`, error);
    coinGeckoCache.set(coinGeckoId, {
      value: undefined,
      expiry: now + COINGECKO_CACHE_TTL_MS,
    });
    return undefined;
  }
}

/**
 * We kick off a refresh every 30 minutes for all keys in the cache.
 * That way we don't return horribly stale information on cold loads.
 */
function scheduleCacheRefreshCron() {
  setInterval(() => {
    const keys = Array.from(coinGeckoCache.keys());
    if (keys.length === 0) return; // Nothing to refresh yet.
    console.log(
      `Refresh: updating CoinGecko cache for keys: ${keys.join(", ")}`
    );
    keys.forEach((id) => {
      fetchAndCacheCoinGeckoPrice(id).catch((err) => console.error(err));
    });
  }, 30 * 60 * 1000);
}

scheduleCacheRefreshCron();
