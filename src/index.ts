import { Elysia } from "elysia";
import { cron, Patterns } from "@elysia/cron";
import { GhostClient } from "ghostfetch";

const BASE_URL = "https://jkt48.com/api/v1";
const MEMBER_ID = 39;
const CACHE_TTL_MS = 15 * 60 * 1000; // Cache lives for 15 minutes
const DETAIL_CONCURRENCY = 5; // You can safely raise this back to 5 on a dedicated backend!
const REQUEST_TIMEOUT_MS = 25_000;
const UPSTREAM_DIAGNOSTIC_TIMEOUT_MS = 8_000;

interface Member {
  name: string;
  type: string;
  member_id: number;
}

interface ShowData {
  code: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  jkt48_member: Member[];
  jkt48_member_type: string;
  default_price: number;
  total_quota: number;
  reference_code?: string;
}

interface ScheduleResult {
  source: string;
  month: string;
  year: string;
  member_id: number;
  count: number;
  shows: ShowData[];
}

interface CacheEntry {
  expiresAt: number;
  result: ScheduleResult;
}

// 1. These maps will now safely persist in RAM forever because Elysia is a long-running process
const scheduleCache = new Map<string, CacheEntry>();
const pendingRequests = new Map<string, Promise<ScheduleResult>>();

function isTargetMemberShow(show: Pick<ShowData, "jkt48_member">) {
  return show.jkt48_member.some((member) => member.member_id === MEMBER_ID);
}

async function fetchJson<T>(client: GhostClient, path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await client.fetch(url);

  if (response.status !== 200) {
    const contentType = response.headers.get("content-type") ?? "unknown";
    const cloudflareMitigation =
      response.headers.get("cf-mitigated") ?? "none";

    throw new Error(
      `JKT48 API error ${path}: ${response.status}; content-type=${contentType}; cf-mitigated=${cloudflareMitigation}`,
    );
  }
  return response.json() as Promise<T>;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

// Core scraping logic
async function fetchOfficialSchedule(
  month: string,
  year: string,
): Promise<ScheduleResult> {
  const client = new GhostClient({
    browser: "Chrome_131",
    timeout: 15_000,
  });

  try {
    const schedulesResponse = await fetchJson<{ data?: ShowData[] }>(
      client,
      `/schedules?lang=id&month=${month}&year=${year}&type=show`,
    );

    const schedules = Array.isArray(schedulesResponse.data)
      ? schedulesResponse.data
      : [];
    const listMatches = schedules.filter(
      (show) => Array.isArray(show.jkt48_member) && isTargetMemberShow(show),
    );

    if (listMatches.length > 0) {
      return {
        source: "elysia-ghostfetch",
        month,
        year,
        member_id: MEMBER_ID,
        count: listMatches.length,
        shows: listMatches,
      };
    }

    const codes = schedules
      .map((show) => show.reference_code)
      .filter((code): code is string => typeof code === "string");

    const showsResponses = await mapWithConcurrency(
      codes,
      DETAIL_CONCURRENCY,
      async (code) => {
        try {
          const showDetail = await fetchJson<{ data?: ShowData }>(
            client,
            `/theater-shows/${code}?lang=id`,
          );
          return showDetail.data ?? null;
        } catch {
          return null;
        }
      },
    );

    const filteredShows = showsResponses.filter((show): show is ShowData => {
      if (!show || !Array.isArray(show.jkt48_member)) return false;
      return isTargetMemberShow(show);
    });

    return {
      source: "elysia-ghostfetch",
      month,
      year,
      member_id: MEMBER_ID,
      count: filteredShows.length,
      shows: filteredShows,
    };
  } finally {
    await client.destroy().catch(() => {});
  }
}

// Request deduplicator
async function getSchedule(month: string, year: string) {
  const key = `${year}-${month}`;
  const cached = scheduleCache.get(key);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return { result: cached.result, cacheStatus: "HIT" };
  }

  const pending = pendingRequests.get(key);
  if (pending) {
    return { result: await pending, cacheStatus: "PENDING" };
  }

  const requestPromise = fetchOfficialSchedule(month, year);
  pendingRequests.set(key, requestPromise);

  try {
    const result = await requestPromise;
    scheduleCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return { result, cacheStatus: "MISS" };
  } finally {
    pendingRequests.delete(key);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Schedule request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function checkNativeUpstream(url: string) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    UPSTREAM_DIAGNOSTIC_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });

    return {
      ok: true,
      status: response.status,
      contentType: response.headers.get("content-type"),
      cloudflareMitigation: response.headers.get("cf-mitigated"),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkGhostfetchUpstream(url: string) {
  const startedAt = Date.now();
  const client = new GhostClient({
    browser: "Chrome_131",
    timeout: UPSTREAM_DIAGNOSTIC_TIMEOUT_MS,
  });

  try {
    const response = await withTimeout(
      client.fetch(url, { timeout: UPSTREAM_DIAGNOSTIC_TIMEOUT_MS }),
      UPSTREAM_DIAGNOSTIC_TIMEOUT_MS + 2_000,
    );

    return {
      ok: true,
      status: response.status,
      contentType: response.headers.get("content-type"),
      cloudflareMitigation: response.headers.get("cf-mitigated"),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await client.destroy().catch(() => {});
  }
}

// 2. Initialize Elysia App
const port = Number(process.env.PORT ?? 3000);

const app = new Elysia({
  serve: {
    hostname: "0.0.0.0",
  },
})
  .get("/healthz", () => ({ ok: true }))
  .get("/debug/upstream", async ({ query }) => {
    const now = new Date();
    const month = query.month ?? String(now.getMonth() + 1);
    const year = query.year ?? String(now.getFullYear());
    const url = `${BASE_URL}/schedules?lang=id&month=${month}&year=${year}&type=show`;

    const [nativeFetch, ghostfetch] = await Promise.all([
      checkNativeUpstream(url),
      checkGhostfetchUpstream(url),
    ]);

    return {
      url,
      nativeFetch,
      ghostfetch,
    };
  })
  // Background Worker: Scrape the current month automatically every 15 minutes
  .use(
    cron({
      name: "background-scraper",
      pattern: Patterns.everyMinutes(15),
      async run() {
        const now = new Date();
        const month = String(now.getMonth() + 1);
        const year = String(now.getFullYear());

        console.log(`[cron] Background scrape triggered for ${month}/${year}`);
        try {
          await getSchedule(month, year);
          console.log(`[cron] Cache warmed successfully.`);
        } catch (error) {
          console.error(`[cron] Scrape failed:`, error);
        }
      },
    }),
  )
  // Public API Endpoint
  .get("/api/schedule", async ({ query, set }) => {
    try {
      const now = new Date();
      const month = query.month ?? String(now.getMonth() + 1);
      const year = query.year ?? String(now.getFullYear());

      console.log(`[api/schedule] Fetching schedule for ${month}/${year}`);
      const { result, cacheStatus } = await withTimeout(
        getSchedule(month, year),
        REQUEST_TIMEOUT_MS,
      );

      set.headers = {
        "Cache-Control": "public, s-maxage=300",
        "X-Schedule-Cache": cacheStatus,
      };

      console.log(
        `[api/schedule] Returning ${result.count} shows for ${month}/${year}; cache=${cacheStatus}`,
      );
      return result.shows;
    } catch (error) {
      console.error("[api/schedule] Failed to fetch schedules:", error);
      set.status =
        error instanceof Error && error.message.includes("timed out")
          ? 504
          : 502;
      return { error: "Failed to fetch schedules" };
    }
  })
  .listen(port);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
