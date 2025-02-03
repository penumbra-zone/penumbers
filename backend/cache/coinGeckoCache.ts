import type { Metadata } from "@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb";

const COINGECKO_CACHE_TTL_MS = 60 * 1000; // one minute

// Small cache-aside layer for coin gecko (guecko? gekko?) prices.
interface CacheEntry {
  value: number | undefined;
  expiry: number;
}

const coinGeckoCache = new Map<string, CacheEntry>();

// We ONLY block if the cache is empty, but otherwise, we prefer
// to return slightly stale values than to block the request.
export async function fetchCoinGeckoPrice(
  metadata: Metadata
): Promise<number | undefined> {
  const coinGeckoId = metadata.coingeckoId || metadata.symbol;
  if (!coinGeckoId) return undefined;

  const now = Date.now();
  const cached = coinGeckoCache.get(coinGeckoId);
  if (cached) {
    if (cached.expiry > now) {
      return cached.value;
    } else {
      // We return a value immediately but trigger a refresh.
      refreshCoinGeckoPrice(coinGeckoId);
      return cached.value;
    }
  }

  return await fetchAndCacheCoinGeckoPrice(coinGeckoId);
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
 * Fires off a background refresh of the CoinGecko price.
 * Duplicate refreshes are not prevented in this implementation, but eh. probably fine.
 */
function refreshCoinGeckoPrice(coinGeckoId: string) {
  (async () => {
    const now = Date.now();
    try {
      const response = await fetch(
        `https://pro-api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd&x_cg_pro_api_key=${process.env.COINGECKO_API_KEY}`
      );
      if (!response.ok) {
        console.error(
          `Failed to refresh CoinGecko price for ${coinGeckoId}, status: ${response.status}`
        );
        coinGeckoCache.set(coinGeckoId, {
          value: undefined,
          expiry: now + COINGECKO_CACHE_TTL_MS,
        });
        return;
      }
      const data = await response.json();
      const price = data[coinGeckoId]?.usd;
      coinGeckoCache.set(coinGeckoId, {
        value: price,
        expiry: now + COINGECKO_CACHE_TTL_MS,
      });
    } catch (error) {
      console.error(
        `Error refreshing CoinGecko price for ${coinGeckoId}:`,
        error
      );
      coinGeckoCache.set(coinGeckoId, {
        value: undefined,
        expiry: now + COINGECKO_CACHE_TTL_MS,
      });
    }
  })();
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
  }, 30 * 60 * 1000); // 30 min
}

scheduleCacheRefreshCron();
