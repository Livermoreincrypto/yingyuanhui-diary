"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client-fetch";

type AuthStatus = {
  loggedIn: boolean;
  count?: number;
  nickname?: string;
  lastLoginAt?: string;
};

type Published = {
  year: number;
  fetchedMatchCount: number;
  matchCount: number;
  commitUrl?: string | null;
  pageUrl: string;
};

export default function AdminYearbookPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrStatus, setQrStatus] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [campId, setCampId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [published, setPublished] = useState<Published | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/auth", { cache: "no-store" })
      .then((response) => response.json())
      .then(async (json) => {
        if (!json.ok || !json.data.authenticated) {
          router.replace("/admin/login");
          return;
        }
        const authResponse = await apiFetch("/api/admin/camp-auth", { cache: "no-store" });
        const authJson = await authResponse.json();
        if (authResponse.status === 401) {
          router.replace("/admin/login");
          return;
        }
        if (authJson.ok) setAuth(authJson.data);
        setReady(true);
      })
      .catch(() => router.replace("/admin/login"));
  }, [router]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const response = await apiFetch(`/api/admin/yearbook/qq-login?taskId=${encodeURIComponent(taskId)}`);
        const json = await response.json();
        if (cancelled || !json.ok) return;
        const status = String(json.data.status || "");
        if (status === "waiting") {
          setQrStatus("等待扫码…");
        } else if (status === "scanned") {
          setQrStatus("已扫码，请在手机上确认登录");
        } else if (status === "success") {
          setAuth(json.data.auth);
          setQrStatus("QQ 登录成功，可以更新年鉴了");
          setTaskId(null);
          setQr(null);
        } else if (status === "expired" || status === "canceled") {
          setQrStatus(status === "expired" ? "二维码已过期，请重新获取" : "已取消登录");
          setTaskId(null);
          setQr(null);
        } else if (status === "error") {
          setQrStatus(json.data.message || "登录失败，请重新获取二维码");
          setTaskId(null);
          setQr(null);
        }
      } catch {
        // Keep polling through transient network errors.
      }
    }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId]);

  async function startQqLogin() {
    setError("");
    setPublished(null);
    setQrStatus("正在获取二维码…");
    try {
      const response = await apiFetch("/api/admin/yearbook/qq-login", { method: "POST" });
      const json = await response.json();
      if (response.status === 401) {
        router.replace("/admin/login");
        return;
      }
      if (!json.ok) {
        setError(json.error || "获取二维码失败");
        setQrStatus("");
        return;
      }
      setTaskId(json.data.taskId);
      setQr(json.data.qrcodeBase64);
      setQrStatus("请使用 QQ 扫码，并在手机上确认登录");
    } catch {
      setError("网络错误，暂时无法获取二维码");
      setQrStatus("");
    }
  }

  async function updateYearbook() {
    const normalizedCampId = campId.trim();
    if (!/^\d{5,15}$/.test(normalizedCampId)) {
      setError("请输入 5 至 15 位数字的王者营地 ID");
      return;
    }

    setPublishing(true);
    setError("");
    setMessage("正在同步营地战绩、核验五人同场记录并发布到 GitHub Pages…");
    setPublished(null);
    try {
      const response = await apiFetch("/api/admin/yearbook/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: 2026, campId: normalizedCampId }),
      });
      const json = await response.json();
      if (response.status === 401) {
        router.replace("/admin/login");
        return;
      }
      if (!json.ok) {
        setError(json.error || "更新失败");
        setMessage("");
        return;
      }
      setPublished(json.data);
      setMessage(`已发布：本次核验 ${json.data.fetchedMatchCount} 场，页面共展示 ${json.data.matchCount} 场。GitHub Pages 通常需要片刻刷新。`);
    } catch {
      setError("网络错误；如果同步时间较长，可稍后打开年鉴确认是否已更新");
      setMessage("");
    } finally {
      setPublishing(false);
    }
  }

  if (!ready) return <div className="p-8 text-center text-[var(--muted)]">校验登录…</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6 fade-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--gold-bright)]">开黑年鉴更新</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            QQ 扫码登录并输入营地 ID 后，刷新 2026 年五排记录并发布到公开年鉴。
          </p>
        </div>
        <Link href="/admin" className="btn btn-ghost !py-2">返回管理后台</Link>
      </div>

      <section className="panel space-y-4 p-4">
        <div>
          <h2 className="text-lg font-medium text-[var(--gold-bright)]">1. 王者营地 QQ 登录</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {auth?.loggedIn
              ? `已有可用营地登录态${auth.nickname ? `：${auth.nickname}` : ""}。如需切换 QQ 账号，可重新扫码。`
              : "先用绑定游戏账号的 QQ 扫码，并在手机上确认授权。"}
          </p>
        </div>

        <label className="block max-w-sm text-sm text-[var(--muted)]">
          王者营地 ID
          <input
            className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] placeholder:text-[var(--muted)] outline-none focus:border-[var(--gold-bright)]"
            inputMode="numeric"
            autoComplete="off"
            maxLength={15}
            placeholder="请输入 5 至 15 位数字"
            value={campId}
            onChange={(event) => setCampId(event.currentTarget.value.replace(/\D/g, "").slice(0, 15))}
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={startQqLogin} disabled={Boolean(taskId)}>
            {taskId ? "等待扫码…" : auth?.loggedIn ? "重新扫码登录" : "获取 QQ 登录二维码"}
          </button>
          <Link href="/admin" className="btn btn-ghost">查看营地账号状态</Link>
        </div>

        {qr && (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:image/png;base64,${qr}`} alt="QQ 登录二维码" className="h-48 w-48 rounded-lg border border-[var(--line)] bg-white p-2" />
            <p className="text-sm text-[var(--muted)]">{qrStatus}</p>
          </div>
        )}
        {!qr && qrStatus && <p className="text-sm text-[var(--muted)]">{qrStatus}</p>}
        <p className="text-xs leading-6 text-[var(--muted)]">
          扫码授权会经过上方配置的中转服务并由其处理；登录态随后保存在本后台，不会写入公开年鉴仓库。只对你认可的 HTTPS 中转服务扫码。
        </p>
      </section>

      <section className="panel space-y-4 p-4">
        <div>
          <h2 className="text-lg font-medium text-[var(--gold-bright)]">2. 更新公开数据</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
            后台会同步配置的营地账号，筛选五位队友同场的已核验对局，并把数据提交到年鉴仓库。原有手动战绩会保留；撞上的对局以营地记录为准。
          </p>
        </div>
        <button className="btn btn-primary" onClick={updateYearbook} disabled={publishing || !auth?.loggedIn || !/^\d{5,15}$/.test(campId.trim())}>
          {publishing ? "同步并发布中…" : "立即更新 2026 年鉴"}
        </button>
        {!auth?.loggedIn && <p className="text-sm text-[var(--muted)]">请先完成 QQ 扫码登录。</p>}
        {auth?.loggedIn && !/^\d{5,15}$/.test(campId.trim()) && <p className="text-sm text-[var(--muted)]">请先填写王者营地 ID。</p>}
        {message && <p className="text-sm text-[var(--mint)]">{message}</p>}
        {error && <p className="text-sm text-[var(--crimson)]">{error}</p>}
        {published && (
          <div className="flex flex-wrap gap-3 text-sm">
            <a className="text-[var(--gold-bright)] underline underline-offset-4" href={published.pageUrl} target="_blank" rel="noreferrer">打开公开年鉴</a>
            {published.commitUrl && <a className="text-[var(--gold-bright)] underline underline-offset-4" href={published.commitUrl} target="_blank" rel="noreferrer">查看更新记录</a>}
          </div>
        )}
      </section>
    </div>
  );
}
