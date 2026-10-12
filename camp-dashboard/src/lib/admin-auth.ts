import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE = "admin_token";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getSecret() {
  const secret = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须设置 ADMIN_SECRET 或 ADMIN_PASSWORD");
  }
  return new TextEncoder().encode(secret || "dev-admin-secret");
}

export function getAdminPassword() {
  const password = process.env.ADMIN_PASSWORD?.trim();
  if (!password && process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须设置 ADMIN_PASSWORD");
  }
  return password || "admin";
}

export async function createAdminToken() {
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(getSecret());
}

export async function verifyAdminToken(token: string | undefined | null) {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload.role === "admin";
  } catch {
    return false;
  }
}

export async function isAdminAuthenticated() {
  const jar = await cookies();
  return verifyAdminToken(jar.get(COOKIE)?.value);
}

export function setAdminCookie(res: NextResponse, token: string) {
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function clearAdminCookie(res: NextResponse) {
  res.cookies.set(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export async function requireAdmin() {
  const ok = await isAdminAuthenticated();
  if (!ok) {
    const err = new Error("未登录或无权限") as Error & { status: number };
    err.status = 401;
    throw err;
  }
}
