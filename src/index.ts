import { Elysia } from "elysia";
import { GhostClient } from "ghostfetch";

const BASE_URL = "https://jkt48.com/api/v1";
const MEMBER_ID = 39;
const DETAIL_CONCURRENCY = 1;
const REQUEST_TIMEOUT_MS = 55_000;
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
  console.log(`[fetchOfficialSchedule] Starting ${month}/${year}`);
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
    console.log(
      `[fetchOfficialSchedule] Loaded ${schedules.length} list items for ${month}/${year}`,
    );

    const listMatches = schedules.filter(
      (show) => Array.isArray(show.jkt48_member) && isTargetMemberShow(show),
    );

    if (listMatches.length > 0) {
      console.log(
        `[fetchOfficialSchedule] Found ${listMatches.length} matches in list payload`,
      );
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

    console.log(
      `[fetchOfficialSchedule] Fetching ${codes.length} detail records with concurrency=${DETAIL_CONCURRENCY}`,
    );
    const showsResponses = await mapWithConcurrency(
      codes,
      DETAIL_CONCURRENCY,
      async (code) => {
        try {
          console.log(`[fetchOfficialSchedule] Fetching detail ${code}`);
          const showDetail = await fetchJson<{ data?: ShowData }>(
            client,
            `/theater-shows/${code}?lang=id`,
          );
          console.log(`[fetchOfficialSchedule] Loaded detail ${code}`);
          return showDetail.data ?? null;
        } catch (error) {
          console.error(
            `[fetchOfficialSchedule] Detail ${code} failed:`,
            error,
          );
          return null;
        }
      },
    );

    const filteredShows = showsResponses.filter((show): show is ShowData => {
      if (!show || !Array.isArray(show.jkt48_member)) return false;
      return isTargetMemberShow(show);
    });

    console.log(
      `[fetchOfficialSchedule] Found ${filteredShows.length} matches in detail payloads`,
    );
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
  // Public API Endpoint
  .get("/api/schedule", async ({ query, set }) => {
    try {
      const now = new Date();
      const month = query.month ?? String(now.getMonth() + 1);
      const year = query.year ?? String(now.getFullYear());

      console.log(`[api/schedule] Fetching schedule for ${month}/${year}`);
      const result = await withTimeout(
        fetchOfficialSchedule(month, year),
        REQUEST_TIMEOUT_MS,
      );

      set.headers = {
        "Cache-Control": "no-store",
        "X-Schedule-Cache": "BYPASS",
      };

      console.log(
        `[api/schedule] Returning ${result.count} shows for ${month}/${year}; cache=BYPASS`,
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
