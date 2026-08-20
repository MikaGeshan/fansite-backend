import http from "node:http";
import { chromium } from "playwright";

const BASE_URL = "https://jkt48.com/api/v1";
const MEMBER_ID = 39;
const DETAIL_CONCURRENCY = 1;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 180_000);
const PLAYWRIGHT_TIMEOUT_MS = Number(
  process.env.PLAYWRIGHT_TIMEOUT_MS ?? 90_000,
);
const UPSTREAM_DIAGNOSTIC_TIMEOUT_MS = Number(
  process.env.UPSTREAM_DIAGNOSTIC_TIMEOUT_MS ?? 90_000,
);

let browserPromise;

process.on("unhandledRejection", (error) => {
  console.error("[process] Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception:", error);
});

async function getBrowser() {
  if (!browserPromise) {
    console.log("[playwright] Launching Chromium");
    browserPromise = chromium
      .launch({
        headless: true,
        channel: process.env.PLAYWRIGHT_CHANNEL ?? "chromium",
        args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
      })
      .catch((error) => {
        browserPromise = undefined;
        throw error;
      });
  }

  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;

  const browser = await browserPromise.catch(() => null);
  browserPromise = undefined;
  await browser?.close().catch(() => {});
}

process.on("SIGTERM", () => {
  closeBrowser().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  closeBrowser().finally(() => process.exit(0));
});

function isTargetMemberShow(show) {
  return show.jkt48_member.some((member) => member.member_id === MEMBER_ID);
}

async function createPage() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      accept: "application/json,text/plain,*/*",
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PLAYWRIGHT_TIMEOUT_MS);
  return { context, page };
}

async function readPageText(page) {
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText?.trim() ?? "";
      return text.startsWith("{") || text.startsWith("[");
    },
    null,
    { timeout: PLAYWRIGHT_TIMEOUT_MS },
  );

  return page.locator("body").innerText({ timeout: PLAYWRIGHT_TIMEOUT_MS });
}

async function fetchJsonWithPage(page, path) {
  const url = `${BASE_URL}${path}`;
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: PLAYWRIGHT_TIMEOUT_MS,
  });

  const status = response?.status() ?? 0;
  const headers = response?.headers() ?? {};
  const text = await readPageText(page);

  if (status !== 200) {
    throw new Error(
      `JKT48 API error ${path}: ${status}; content-type=${headers["content-type"] ?? "unknown"}; cf-mitigated=${headers["cf-mitigated"] ?? "none"}; body=${text.slice(0, 120)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `JKT48 API returned non-JSON for ${path}: ${error instanceof Error ? error.message : String(error)}; body=${text.slice(0, 120)}`,
    );
  }
}

async function fetchJsonWithFreshPage(path) {
  const { context, page } = await createPage();

  try {
    return await fetchJsonWithPage(page, path);
  } finally {
    await context.close().catch(() => {});
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
  const { context, page } = await createPage();

  try {
    const schedulesResponse = await fetchJsonWithPage(
      page,
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
        source: "node-playwright",
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
          const showDetail = await fetchJsonWithPage(
            page,
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
      source: "node-playwright",
      month,
      year,
      member_id: MEMBER_ID,
      count: filteredShows.length,
      shows: filteredShows,
    };
  } finally {
    await context.close().catch(() => {});
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

async function checkPlaywrightUpstream(path) {
  const startedAt = Date.now();

  try {
    const data = await withTimeout(
      fetchJsonWithFreshPage(path),
      UPSTREAM_DIAGNOSTIC_TIMEOUT_MS,
    );

    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      hasData: Boolean(data.data),
      count: Array.isArray(data.data) ? data.data.length : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
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
    const path = `/schedules?lang=id&month=${month}&year=${year}&type=show`;
    const upstreamUrl = `${BASE_URL}${path}`;

    const [nativeFetch, playwright] = await Promise.all([
      checkNativeUpstream(upstreamUrl),
      checkPlaywrightUpstream(path),
    ]);

    sendJson(response, 200, {
      url: upstreamUrl,
      nativeFetch,
      playwright,
    });
    return;
  }

  if (url.pathname === "/debug/browser") {
    const startedAt = Date.now();

    try {
      const { context, page } = await createPage();
      await page.setContent("<html><body>ok</body></html>", {
        timeout: PLAYWRIGHT_TIMEOUT_MS,
      });
      const text = await page.locator("body").innerText();
      await context.close().catch(() => {});

      sendJson(response, 200, {
        ok: true,
        text,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error("[debug/browser] Browser check failed:", error);
      await closeBrowser();
      sendJson(response, 502, {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
        fetchJsonWithFreshPage(path),
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
  console.log(`[server] ${request.method} ${request.url}`);
  handleRequest(request, response).catch((error) => {
    console.error("[server] Unhandled request error:", error);

    if (!response.headersSent) {
      sendJson(response, 500, { error: "Internal server error" });
      return;
    }

    response.destroy(error instanceof Error ? error : undefined);
  });
});

server.on("error", (error) => {
  console.error("[server] Listen/server error:", error);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Schedule API listening on 0.0.0.0:${port}`);
});
