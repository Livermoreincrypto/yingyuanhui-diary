import crypto from "node:crypto";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import type { CampAuthAccount } from "./auth-store";
import { buildSpecialEncodeParam, decodeEncodeRes } from "./wechat-login";

const CAMP_QQ_APP_ID = "1105200115";
const LOGIN_PAGE = new URL("https://openmobile.qq.com/oauth2.0/m_authorize");
LOGIN_PAGE.searchParams.set("client_id", CAMP_QQ_APP_ID);
LOGIN_PAGE.searchParams.set("scope", "all");
LOGIN_PAGE.searchParams.set("redirect_uri", "auth://tauth.qq.com/");
LOGIN_PAGE.searchParams.set("style", "qr");
LOGIN_PAGE.searchParams.set("response_type", "code");

const QR_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; V2366GA Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Safari/537.36 tencent_game_emulator";
const SESSION_TTL_MS = 3 * 60 * 1000;
const PAGE_TIMEOUT_MS = 60 * 1000;
const QR_WAIT_TIMEOUT_MS = 25 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const CAMP_BASE_URL = "https://ssl.kohsocialapp.qq.com:10001";

export type QqLoginResult =
  | { status: "waiting" }
  | { status: "scanned" }
  | { status: "success"; account: CampAuthAccount }
  | { status: "expired" }
  | { status: "canceled" }
  | { status: "error"; message: string };

type QrBox = { x: number; y: number; width: number; height: number };
type QqLoginSession = {
  taskId: string;
  browser: Browser;
  page: Page;
  qrcodeBase64: string;
  expiresAt: string;
  status: "waiting" | "scanned" | "success" | "expired" | "error";
  account?: CampAuthAccount;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
};

type JsonObject = Record<string, unknown>;

const sessions = new Map<string, QqLoginSession>();
let creatingSession = false;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

async function closeSession(session: QqLoginSession) {
  if (session.closing) return session.closing;
  if (session.timer) clearTimeout(session.timer);
  session.closing = (async () => {
    try {
      await session.page.close();
    } catch {
      // The browser may already have closed the page.
    }
    try {
      await session.browser.close();
    } catch {
      // Chromium may already have exited.
    }
  })();
  return session.closing;
}

async function clearSessions() {
  const current = [...sessions.values()];
  sessions.clear();
  await Promise.all(current.map(closeSession));
}

async function locateQr(page: Page): Promise<QrBox | null> {
  const deadline = Date.now() + QR_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const box = await page
      .evaluate(() => {
        const selectors = [
          "#qrlogin_img",
          ".qrlogin_img",
          'img[src*="ptqrshow"]',
          'img[src*="qrcode"]',
          "canvas#qrlogin_canvas",
          ".qrlogin canvas",
        ];
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (!element) continue;
          const rect = element.getBoundingClientRect();
          if (rect.width >= 100 && rect.height >= 100) {
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }
        }
        return null;
      })
      .catch(() => null);
    if (box) return box;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function captureQr(page: Page, box: QrBox) {
  const x = Math.max(0, Math.floor(box.x - 8));
  const y = Math.max(0, Math.floor(box.y - 8));
  const viewport = page.viewport();
  const width = Math.min(Math.ceil(box.width + 16), (viewport?.width || 420) - x);
  const height = Math.min(Math.ceil(box.height + 16), (viewport?.height || 760) - y);
  if (width <= 0 || height <= 0) throw new Error("二维码区域无效");
  const image = await page.screenshot({
    type: "png",
    clip: { x, y, width, height },
    captureBeyondViewport: false,
  });
  return Buffer.from(image).toString("base64");
}

async function exchangeCodeForTokens(code: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ appID: CAMP_QQ_APP_ID, loginCode: code });
  const signatureBase = `POST\n/cmd/QQCodeLogin\njson\nysdk\n${timestamp}\n${body}`;
  const digest = crypto
    .createHmac("sha256", "yyb@cloud_game:CQ8FA#")
    .update(signatureBase)
    .digest("base64");

  const response = await fetch("https://ysdk.qq.com/cmd/QQCodeLogin?", {
    method: "POST",
    headers: {
      "Content-Type": "json",
      "Auth-Secret-ID": "ysdk",
      "Auth-Secret-Digest": digest,
      "Auth-Request-Time": timestamp,
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const result = asObject(await response.json().catch(() => null));
  const data = asObject(result?.data);
  if (!response.ok || Number(result?.code) !== 0 || Number(data?.ret) !== 0) {
    throw new Error("QQ 授权未能换取营地登录凭证");
  }

  const accessToken = asString(data?.accessToken);
  const openId = asString(data?.openID);
  if (!accessToken || !openId) throw new Error("QQ 登录凭证不完整");
  return {
    accessToken,
    openId,
    payToken: asString(data?.payToken),
    refreshToken: asString(data?.refreshToken),
  };
}

async function loginCampByOpenSdk(tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>) {
  const version = {
    cChannelId: "10003391",
    cClientVersionCode: "2057971306",
    cClientVersionName: "10.114.0826",
    cCurrentGameId: "20001",
    cGameId: "20001",
    cGzip: "1",
    cIsArm64: "true",
    cRand: String(Date.now()),
    cSupportArm64: "true",
    cSystem: "android",
    cSystemVersionCode: "35",
    cSystemVersionName: "15",
    cpuHardware: "qcom",
    gameId: "20001",
    tinkerId: "2057971306_64_0",
  };
  const form = new URLSearchParams({
    delOldUser: "0",
    key1: crypto.randomUUID().replace(/-/g, ""),
    lastLoginTime: "0",
    lastGetRemarkTime: "0",
    ...version,
    specialEncodeParam: buildSpecialEncodeParam(),
    loginType: "openSdk",
    accessToken: tokens.accessToken,
    openId: tokens.openId,
    payToken: tokens.payToken,
  });
  const response = await fetch(`${CAMP_BASE_URL}/user/login`, {
    method: "POST",
    headers: {
      "Content-Encrypt": "",
      "Accept-Encrypt": "",
      NOENCRYPT: "1",
      "X-Client-Proto": "https",
      "User-Agent": "okhttp/4.9.1",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-log-uid": crypto.randomUUID().toUpperCase(),
      ...version,
      specialEncodeParam: form.get("specialEncodeParam") || "",
    },
    body: form.toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const result = asObject(await response.json().catch(() => null));
  const data = asObject(result?.data);
  const userId = asString(data?.userId);
  const token = asString(data?.token);
  const encodeRes = asString(data?.encodeRes);
  if (!response.ok || Number(result?.returnCode) !== 0 || !userId || !token || !encodeRes) {
    throw new Error("王者营地未能完成 QQ 登录");
  }

  const encoded = decodeEncodeRes(encodeRes);
  return {
    userId,
    token,
    userKey: asString(encoded?.userKey),
    encodeRes,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    appOpenid: asString(data?.appOpenid) || tokens.openId,
    openId: tokens.openId,
    avatar: asString(data?.avatar),
    nickname: asString(data?.nickname),
    snsnickname: asString(data?.snsnickname),
    expires: asString(data?.expires),
    loginPlatform: "qq",
    lastLoginAt: new Date().toISOString(),
  } satisfies CampAuthAccount;
}

async function finishLogin(session: QqLoginSession, code: string) {
  try {
    const tokens = await exchangeCodeForTokens(code);
    session.account = await loginCampByOpenSdk(tokens);
    session.status = "success";
  } catch {
    session.status = "error";
  } finally {
    await closeSession(session);
  }
}

export async function createQqLoginSession() {
  if (creatingSession) {
    throw Object.assign(new Error("正在准备二维码，请稍等片刻再试"), { status: 429 });
  }
  creatingSession = true;
  await clearSessions();

  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    chromium.setGraphicsMode = false;
    browser = await puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      defaultViewport: {
        deviceScaleFactor: 1,
        hasTouch: true,
        height: 760,
        isLandscape: false,
        isMobile: true,
        width: 420,
      },
      executablePath: await chromium.executablePath(),
      headless: "shell",
      timeout: PAGE_TIMEOUT_MS,
    });
    page = await browser.newPage();
    await page.setUserAgent(QR_USER_AGENT);

    const taskId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const qrBoxReady = await page.goto(LOGIN_PAGE.toString(), {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    if (!qrBoxReady) throw new Error("QQ 登录页面没有响应");
    const box = await locateQr(page);
    if (!box) throw new Error("未能获取 QQ 登录二维码");
    const qrcodeBase64 = await captureQr(page, box);

    const session: QqLoginSession = {
      taskId,
      browser,
      page,
      qrcodeBase64,
      expiresAt,
      status: "waiting",
    };
    page.on("request", (request) => {
      const requestUrl = request.url();
      if (!requestUrl.startsWith("auth://") && !requestUrl.includes("tauth.qq.com")) return;
      try {
        const url = new URL(requestUrl);
        const code = url.searchParams.get("code") || "";
        if (!/^[A-Za-z0-9]+$/.test(code) || session.status !== "waiting") return;
        session.status = "scanned";
        void finishLogin(session, code);
      } catch {
        // Ignore unrelated browser requests and malformed redirects.
      }
    });
    session.timer = setTimeout(() => {
      if (session.status === "waiting" || session.status === "scanned") {
        session.status = "expired";
        void closeSession(session);
      }
    }, SESSION_TTL_MS);
    session.timer.unref?.();
    sessions.set(taskId, session);
    return { taskId, qrcodeBase64, expiresAt };
  } catch {
    if (page) await page.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    throw new Error("暂时无法启动 QQ 扫码服务，请稍后重试");
  } finally {
    creatingSession = false;
  }
}

export async function pollQqLoginOnce(taskId: string): Promise<QqLoginResult> {
  const session = sessions.get(taskId);
  if (!session) return { status: "expired" };
  if (Date.parse(session.expiresAt) <= Date.now() || session.status === "expired") {
    sessions.delete(taskId);
    void closeSession(session);
    return { status: "expired" };
  }
  if (session.status === "success" && session.account) {
    sessions.delete(taskId);
    return { status: "success", account: session.account };
  }
  if (session.status === "error") {
    sessions.delete(taskId);
    return { status: "error", message: "QQ 已授权，但营地登录未完成；请刷新二维码重试" };
  }

  if (session.status === "waiting") {
    const scanned = await session.page
      .evaluate(() => /扫码成功|请在手机上确认|已扫码|确认登录/.test(document.body?.innerText || ""))
      .catch(() => false);
    if (scanned) session.status = "scanned";
  }
  return { status: session.status === "scanned" ? "scanned" : "waiting" };
}

export function removeQqLoginSession(taskId: string) {
  const session = sessions.get(taskId);
  if (!session) return;
  sessions.delete(taskId);
  void closeSession(session);
}
