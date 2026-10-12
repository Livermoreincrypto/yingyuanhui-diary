import crypto from "node:crypto";
import type { CampAuthAccount } from "./auth-store";

const SESSION_TTL_MS = 120_000;

export type QqLoginResult =
  | { status: "waiting" }
  | { status: "scanned" }
  | { status: "success"; account: CampAuthAccount }
  | { status: "expired" }
  | { status: "canceled" }
  | { status: "error"; message: string };

type QqLoginSession = {
  taskId: string;
  qrsig: string;
  qrcodeBase64: string;
  expiresAt: string;
};

type JsonObject = Record<string, unknown>;

const sessions = new Map<string, QqLoginSession>();

function relayConfigError(message: string) {
  return Object.assign(new Error(message), { status: 503 });
}

function relayServiceError(message: string) {
  return Object.assign(new Error(message), { status: 503 });
}

function getRelayBase() {
  const value = process.env.QQ_LOGIN_RELAY_BASE_URL?.trim();
  if (!value) throw relayConfigError("请配置 QQ_LOGIN_RELAY_BASE_URL 后再使用 QQ 扫码登录");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw relayConfigError("QQ_LOGIN_RELAY_BASE_URL 格式无效");
  }
  if (url.protocol !== "https:") {
    throw relayConfigError("QQ 登录中转服务必须使用 HTTPS，避免登录凭据以明文传输");
  }
  return url.toString().replace(/\/$/, "");
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function findValueDeep(root: unknown, names: string[], depth = 0): string {
  if (depth > 5) return "";
  const obj = asObject(root);
  if (!obj) return "";
  for (const name of names) {
    const entry = Object.entries(obj).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry) {
      const value = asString(entry[1]);
      if (value) return value;
    }
  }
  for (const value of Object.values(obj)) {
    const found = findValueDeep(value, names, depth + 1);
    if (found) return found;
  }
  return "";
}

async function getJson(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw relayServiceError("QQ 登录服务返回格式异常");
  }
  if (!response.ok) throw relayServiceError("QQ 登录服务暂不可用");
  return asObject(json) || {};
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (Date.parse(session.expiresAt) <= now) sessions.delete(id);
  }
}

export async function createQqLoginSession() {
  pruneSessions();
  const relayBase = getRelayBase();
  const params = new URLSearchParams({ format: "json", flag: "noDocument" });
  const response = await getJson(`${relayBase}/login_qr/api.php?${params}`);
  const data = asObject(response.data);
  const image = asObject(data?.image);
  const qrsig = asString(data?.qrsig);
  const qrcodeBase64 = asString(image?.base64);
  if (response.code !== 200 || !qrsig || !qrcodeBase64) {
    throw new Error("暂时无法生成 QQ 登录二维码，请稍后重试");
  }
  const taskId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  sessions.set(taskId, { taskId, qrsig, qrcodeBase64, expiresAt });
  return { taskId, qrcodeBase64, expiresAt };
}

function accountFromRelay(raw: unknown): CampAuthAccount | null {
  const source = asObject(raw);
  if (!source) return null;
  const userId = findValueDeep(source, ["userId"]);
  const token = findValueDeep(source, ["token"]);
  const userKey = findValueDeep(source, ["userKey"]);
  const encodeRes = findValueDeep(source, ["encodeRes"]);
  if (!userId || !token || (!userKey && !encodeRes)) return null;
  return {
    userId,
    token,
    userKey,
    encodeRes,
    openId: findValueDeep(source, ["openId"]),
    gameOpenId: findValueDeep(source, ["gameOpenId", "gameOpenid"]),
    gameRoleId: findValueDeep(source, ["gameRoleId"]),
    gameServerId: findValueDeep(source, ["gameServerId"]),
    accessToken: findValueDeep(source, ["accessToken"]),
    refreshToken: findValueDeep(source, ["refreshToken"]),
    appOpenid: findValueDeep(source, ["appOpenid"]),
    avatar: findValueDeep(source, ["avatar"]),
    nickname: findValueDeep(source, ["nickname", "nickName"]),
    snsnickname: findValueDeep(source, ["snsnickname"]),
    expires: findValueDeep(source, ["expires"]),
    loginPlatform: "qq",
    lastLoginAt: new Date().toISOString(),
  };
}

async function completeCampLogin(payload: JsonObject): Promise<CampAuthAccount | null> {
  const directAccount = accountFromRelay(payload);
  if (directAccount) return directAccount;

  const openId = findValueDeep(payload, ["openId", "openid"]);
  const accessToken = findValueDeep(payload, ["accessToken", "access_token"]);
  if (!openId || !accessToken) return null;

  const relayBase = getRelayBase();
  const params = new URLSearchParams({
    openId,
    accessToken,
    format: "json",
    flag: "noDocument",
  });
  const response = await getJson(`${relayBase}/login/api.php?${params}`);
  if (response.result !== 0 || response.returnCode !== 0) {
    throw new Error("QQ 已授权，但营地账号登录未完成");
  }
  return accountFromRelay(response.data);
}

export async function pollQqLoginOnce(taskId: string): Promise<QqLoginResult> {
  pruneSessions();
  const session = sessions.get(taskId);
  if (!session) return { status: "expired" };
  if (Date.parse(session.expiresAt) <= Date.now()) {
    sessions.delete(taskId);
    return { status: "expired" };
  }

  try {
    const relayBase = getRelayBase();
    const params = new URLSearchParams({
      qrsig: session.qrsig,
      format: "json",
      flag: "noDocument",
    });
    const response = await getJson(`${relayBase}/login_qr/api.php?${params}`);
    const code = Number(response.code);
    if (code === 66 || code === 205) return { status: "waiting" };
    if (code === 67 || code === 206) return { status: "scanned" };
    if (code === 204) {
      sessions.delete(taskId);
      return { status: "expired" };
    }
    if (code === 208) {
      sessions.delete(taskId);
      return { status: "canceled" };
    }

    const account = await completeCampLogin(response);
    if (account) {
      sessions.delete(taskId);
      return { status: "success", account };
    }
    const statusText = asString(response.status);
    if (/扫码|确认|验证/i.test(statusText)) return { status: "scanned" };
    if (/未失效|等待/i.test(statusText)) return { status: "waiting" };
    return { status: "error", message: "QQ 登录返回了未识别的状态，请刷新二维码重试" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "QQ 登录状态查询失败",
    };
  }
}

export function removeQqLoginSession(taskId: string) {
  sessions.delete(taskId);
}
