import http from "node:http";
import { GhostClient } from "ghostfetch";

const BASE_URL = "https://jkt48.com/api/v1";
const MEMBER_ID = 39;
const DETAIL_CONCURRENCY = 1;
const REQUEST_TIMEOUT_MS = 120_000;
const UPSTREAM_DIAGNOSTIC_TIMEOUT_MS = 8_000;

process.on("unhandledRejection", (error) => {
  console.error("[process] Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception:", error);
});

function isTargetMemberShow(show) {
  return show.jkt48_member.some((member) => member.member_id === MEMBER_ID);
}

async function fetchJson(client, path) {
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

  return response.json();
}

async function fetchJsonWithFreshClient(path) {
  const client = new GhostClient({
    browser: "Chrome_131",
    timeout: 15_000,
  });

  try {
    return await fetchJson(client, path);
  } finally {
    await client.destroy().catch(() => {});
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
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

async function fetchOfficialSchedule(month, year) {
  console.log(`[fetchOfficialSchedule] Starting ${month}/${year}`);
  const client = new GhostClient({
    browser: "Chrome_131",
    timeout: 15_000,
  });

  try {
    const schedulesResponse = await fetchJson(
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
        source: "node-ghostfetch",
        month,
        year,
        member_id: MEMBER_ID,
        count: listMatches.length,
        shows: listMatches,
      };
    }

    const codes = schedules
      .map((show) => show.reference_code)
      .filter((code) => typeof code === "string");

    console.log(
      `[fetchOfficialSchedule] Fetching ${codes.length} detail records with concurrency=${DETAIL_CONCURRENCY}`,
    );
    const showsResponses = await mapWithConcurrency(
      codes,
      DETAIL_CONCURRENCY,
      async (code) => {
        try {
          console.log(`[fetchOfficialSchedule] Fetching detail ${code}`);
          const showDetail = await fetchJson(
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

    const filteredShows = showsResponses.filter((show) => {
      if (!show || !Array.isArray(show.jkt48_member)) return false;
      return isTargetMemberShow(show);
    });

    console.log(
      `[fetchOfficialSchedule] Found ${filteredShows.length} matches in detail payloads`,
    );
    return {
      source: "node-ghostfetch",
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

async function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
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

async function checkNativeUpstream(url) {
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

async function checkGhostfetchUpstream(url) {
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

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    "content-type": "application/json;charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === "/debug/upstream") {
    const now = new Date();
    const month = url.searchParams.get("month") ?? String(now.getMonth() + 1);
    const year = url.searchParams.get("year") ?? String(now.getFullYear());
    const upstreamUrl = `${BASE_URL}/schedules?lang=id&month=${month}&year=${year}&type=show`;

    const [nativeFetch, ghostfetch] = await Promise.all([
      checkNativeUpstream(upstreamUrl),
      checkGhostfetchUpstream(upstreamUrl),
    ]);

    sendJson(response, 200, {
      url: upstreamUrl,
      nativeFetch,
      ghostfetch,
    });
    return;
  }

  if (url.pathname === "/debug/detail") {
    const code = url.searchParams.get("code");

    if (!code || code.trim() === "") {
      sendJson(response, 400, { error: "Missing code query param" });
      return;
    }

    const path = `/theater-shows/${code}?lang=id`;
    const startedAt = Date.now();

    try {
      const showDetail = await withTimeout(
        fetchJsonWithFreshClient(path),
        REQUEST_TIMEOUT_MS,
      );

      sendJson(response, 200, {
        ok: true,
        code,
        elapsedMs: Date.now() - startedAt,
        hasData: Boolean(showDetail.data),
        memberCount: showDetail.data?.jkt48_member?.length ?? 0,
        hasTargetMember:
          showDetail.data && Array.isArray(showDetail.data.jkt48_member)
            ? isTargetMemberShow(showDetail.data)
            : false,
      });
    } catch (error) {
      console.error(`[debug/detail] ${code} failed:`, error);
      sendJson(
        response,
        error instanceof Error && error.message.includes("timed out")
          ? 504
          : 502,
        {
          ok: false,
          code,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return;
  }

  if (url.pathname === "/api/schedule") {
    const now = new Date();
    const month = url.searchParams.get("month") ?? String(now.getMonth() + 1);
    const year = url.searchParams.get("year") ?? String(now.getFullYear());

    try {
      console.log(`[api/schedule] Fetching schedule for ${month}/${year}`);
      const result = await withTimeout(
        fetchOfficialSchedule(month, year),
        REQUEST_TIMEOUT_MS,
      );

      console.log(
        `[api/schedule] Returning ${result.count} shows for ${month}/${year}; cache=BYPASS`,
      );
      sendJson(response, 200, result.shows, {
        "cache-control": "no-store",
        "x-schedule-cache": "BYPASS",
      });
    } catch (error) {
      console.error("[api/schedule] Failed to fetch schedules:", error);
      sendJson(
        response,
        error instanceof Error && error.message.includes("timed out")
          ? 504
          : 502,
        { error: "Failed to fetch schedules" },
      );
    }
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("[server] Unhandled request error:", error);

    if (!response.headersSent) {
      sendJson(response, 500, { error: "Internal server error" });
      return;
    }

    response.destroy(error instanceof Error ? error : undefined);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Schedule API listening on 0.0.0.0:${port}`);
});
