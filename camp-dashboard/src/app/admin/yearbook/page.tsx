"use client";

import { type FormEvent, useEffect, useState } from "react";
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

type ManualPlayer = {
  name: string;
  accountName: string;
  hero: string;
  role: string;
  rating: string;
  mvp: boolean;
};

type ManualForm = {
  date: string;
  result: "win" | "loss";
  mode: string;
  note: string;
  players: ManualPlayer[];
};

type ManualPublished = {
  year: number;
  matchCount: number;
  commitUrl?: string | null;
  pageUrl: string;
};

const YEARBOOK_ROSTER = ["呜呀捉飞鸡", "玩家大薄荷糖", "积极向上的名", "只求爱的人", "Swiftie"];
const PLAYER_ROLES = ["对抗路", "打野", "中路", "发育路", "游走"];

function todayForInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function emptyManualPlayers(): ManualPlayer[] {
  return YEARBOOK_ROSTER.map((name) => ({ name, accountName: "", hero: "", role: "", rating: "", mvp: false }));
}

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
  const [manualForm, setManualForm] = useState<ManualForm>(() => ({
    date: todayForInput(),
    result: "win",
    mode: "排位赛 五排",
    note: "",
    players: emptyManualPlayers(),
  }));
  const [savingManual, setSavingManual] = useState(false);
  const [manualMessage, setManualMessage] = useState("");
  const [manualError, setManualError] = useState("");
  const [manualPublished, setManualPublished] = useState<ManualPublished | null>(null);

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

  function updateManualPlayer(index: number, patch: Partial<ManualPlayer>) {
    setManualForm((current) => ({
      ...current,
      players: current.players.map((player, playerIndex) => playerIndex === index ? { ...player, ...patch } : player),
    }));
  }

  async function saveManualMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingManual(true);
    setManualError("");
    setManualMessage("正在保存并发布这一局…");
    setManualPublished(null);
    try {
      const response = await apiFetch("/api/admin/yearbook/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: manualForm.date,
          result: manualForm.result,
          mode: manualForm.mode,
          note: manualForm.note,
          players: manualForm.players.map((player) => ({
            name: player.name,
            accountName: player.accountName,
            hero: player.hero,
            role: player.role,
            rating: player.rating === "" ? 0 : Number(player.rating),
            mvp: player.mvp,
          })),
        }),
      });
      const json = await response.json();
      if (response.status === 401) {
        router.replace("/admin/login");
        return;
      }
      if (!json.ok) {
        setManualError(json.error || "保存失败，请检查填写内容后重试");
        setManualMessage("");
        return;
      }
      setManualPublished(json.data);
      setManualMessage(`已记入 2026 年鉴，目前公开展示 ${json.data.matchCount} 场。GitHub Pages 通常需要片刻刷新。`);
      setManualForm((current) => ({
        ...current,
        note: "",
        players: current.players.map((player) => ({ ...player, accountName: "", hero: "", role: "", rating: "", mvp: false })),
      }));
    } catch {
      setManualError("网络错误；请打开公开年鉴确认是否已保存，再决定是否重新提交");
      setManualMessage("");
    } finally {
      setSavingManual(false);
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
          二维码和授权流程由本后台服务器直接连接 QQ 与王者营地完成，不经过第三方扫码中转；营地登录态只保存在后台，不会写入公开年鉴。
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

      <section className="panel space-y-4 p-4">
        <div>
          <h2 className="text-lg font-medium text-[var(--gold-bright)]">3. 记一局（手动补录）</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
            适合有人用了小号、营地记录无法匹配的对局。队友按固定小队成员统计；只需给用小号的队友填写“本局使用名”。保存后会直接更新公开年鉴，不需要重新扫码。
          </p>
        </div>

        <form className="space-y-4" onSubmit={saveManualMatch}>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm text-[var(--muted)]">
              日期
              <input
                className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] outline-none focus:border-[var(--gold-bright)]"
                type="date"
                min="2026-01-01"
                max="2026-12-31"
                required
                value={manualForm.date}
                onChange={(event) => setManualForm((current) => ({ ...current, date: event.currentTarget.value }))}
              />
            </label>
            <label className="block text-sm text-[var(--muted)]">
              结果
              <select
                className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] outline-none focus:border-[var(--gold-bright)]"
                value={manualForm.result}
                onChange={(event) => setManualForm((current) => ({ ...current, result: event.currentTarget.value as "win" | "loss" }))}
              >
                <option value="win">胜利</option>
                <option value="loss">失败</option>
              </select>
            </label>
            <label className="block text-sm text-[var(--muted)]">
              模式
              <select
                className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] outline-none focus:border-[var(--gold-bright)]"
                value={manualForm.mode}
                onChange={(event) => setManualForm((current) => ({ ...current, mode: event.currentTarget.value }))}
              >
                <option>排位赛 五排</option>
                <option>排位赛</option>
                <option>匹配</option>
                <option>娱乐</option>
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {manualForm.players.map((player, index) => (
              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)]/50 p-3" key={player.name}>
                <h3 className="mb-3 font-medium text-[var(--text)]">{player.name}</h3>
                <div className="space-y-3">
                  <label className="block text-xs text-[var(--muted)]">
                    本局使用名（选填，小号时填写）
                    <input
                      className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--gold-bright)]"
                      maxLength={40}
                      placeholder={`默认按 ${player.name} 统计`}
                      value={player.accountName}
                      onChange={(event) => updateManualPlayer(index, { accountName: event.currentTarget.value })}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs text-[var(--muted)]">
                      英雄
                      <input
                        className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--gold-bright)]"
                        maxLength={40}
                        placeholder="选填"
                        value={player.hero}
                        onChange={(event) => updateManualPlayer(index, { hero: event.currentTarget.value })}
                      />
                    </label>
                    <label className="block text-xs text-[var(--muted)]">
                      位置
                      <select
                        className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--gold-bright)]"
                        value={player.role}
                        onChange={(event) => updateManualPlayer(index, { role: event.currentTarget.value })}
                      >
                        <option value="">选填</option>
                        {PLAYER_ROLES.map((role) => <option key={role}>{role}</option>)}
                      </select>
                    </label>
                    <label className="block text-xs text-[var(--muted)]">
                      评分
                      <input
                        className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--gold-bright)]"
                        type="number"
                        min="0"
                        max="20"
                        step="0.1"
                        placeholder="选填"
                        value={player.rating}
                        onChange={(event) => updateManualPlayer(index, { rating: event.currentTarget.value })}
                      />
                    </label>
                    <label className="flex items-end gap-2 pb-2 text-sm text-[var(--muted)]">
                      <input
                        className="accent-[var(--gold-bright)]"
                        type="checkbox"
                        checked={player.mvp}
                        onChange={(event) => updateManualPlayer(index, { mvp: event.currentTarget.checked })}
                      />
                      本局 MVP
                    </label>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <label className="block text-sm text-[var(--muted)]">
            本局趣事（选填）
            <input
              className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] outline-none focus:border-[var(--gold-bright)]"
              maxLength={120}
              placeholder="比如：某人用小号也没逃过 MVP"
              value={manualForm.note}
              onChange={(event) => setManualForm((current) => ({ ...current, note: event.currentTarget.value }))}
            />
          </label>

          <button className="btn btn-primary" type="submit" disabled={savingManual}>
            {savingManual ? "正在保存…" : "保存并更新公开年鉴"}
          </button>
          {manualMessage && <p className="text-sm text-[var(--mint)]">{manualMessage}</p>}
          {manualError && <p className="text-sm text-[var(--crimson)]">{manualError}</p>}
          {manualPublished && (
            <div className="flex flex-wrap gap-3 text-sm">
              <a className="text-[var(--gold-bright)] underline underline-offset-4" href={manualPublished.pageUrl} target="_blank" rel="noreferrer">打开公开年鉴</a>
              {manualPublished.commitUrl && <a className="text-[var(--gold-bright)] underline underline-offset-4" href={manualPublished.commitUrl} target="_blank" rel="noreferrer">查看更新记录</a>}
            </div>
          )}
        </form>
      </section>
    </div>
  );
}

