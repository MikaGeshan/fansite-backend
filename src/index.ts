import { Elysia } from "elysia";
import { cron, Patterns } from "@elysia/cron";
import { GhostClient } from "ghostfetch";

const BASE_URL = "https://jkt48.com/api/v1";
const MEMBER_ID = 39;
const CACHE_TTL_MS = 15 * 60 * 1000; // Cache lives for 15 minutes
const DETAIL_CONCURRENCY = 5; // You can safely raise this back to 5 on a dedicated backend!

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
    throw new Error(`API error ${path}: ${response.status}`);
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

// 2. Initialize Elysia App
const port = Number(process.env.PORT ?? 3000);

const app = new Elysia({
  serve: {
    hostname: "0.0.0.0",
  },
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

      const { result, cacheStatus } = await getSchedule(month, year);

      set.headers = {
        "Cache-Control": "public, s-maxage=300",
        "X-Schedule-Cache": cacheStatus,
      };

      return result.shows;
    } catch (error) {
      set.status = 502;
      return { error: "Failed to fetch schedules" };
    }
  })
  .listen(port);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
