"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import CalendarMonth from "./calendar-month";
import { ArrowRight, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy, LoaderCircle, LockKeyhole, Pencil, Plus, RefreshCw, Settings2, Trash2, Users, X } from "lucide-react";
import type { CalendarData, CalendarEvent, Member } from "@/lib/calendar-types";

const fmtMonth = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", timeZone: "UTC" });
const fmtDay = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });
const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const fromIso = (s: string) => new Date(`${s}T00:00:00.000Z`);
const isBetween = (day: string, start: string, end: string) => day >= start && day <= end;
const tokenKey = (cid: string) => `uchiwa:secret:${cid}`;
const pendingTokenKey = (cid: string) => `uchiwa:pending-secret:${cid}`;
const viewKeyKey = (cid: string) => `uchiwa:view-key:${cid}`;
const pendingViewKeyKey = (cid: string) => `uchiwa:pending-view-key:${cid}`;
const sharePath = (cid: string, key?: string) => `/?c=${encodeURIComponent(cid)}${key ? `&k=${encodeURIComponent(key)}` : ""}`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const cid = url.match(/\/api\/calendars\/([^/?]+)/)?.[1];
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const viewKey = cid && typeof localStorage !== "undefined" ? params?.get("c") === decodeURIComponent(cid) ? params.get("k") || localStorage.getItem(viewKeyKey(decodeURIComponent(cid))) : localStorage.getItem(viewKeyKey(decodeURIComponent(cid))) : null;
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(viewKey ? { "X-View-Key": viewKey } : {}), ...init?.headers } });
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) { const err = new Error(body.error || "通信に失敗しました。もう一度お試しください。"); (err as Error & { status?: number }).status = res.status; throw err; }
  return body as T;
}

function makeToken() {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function makeUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function CalendarApp() {
  const [cid, setCid] = useState("");
  const [data, setData] = useState<CalendarData | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createName, setCreateName] = useState("");
  const [month, setMonth] = useState("");
  const [today, setToday] = useState("");
  const [selected, setSelected] = useState("");
  const [muted, setMuted] = useState<string[]>([]);
  const [modal, setModal] = useState<"event" | "join" | "settings" | "delete" | "switch" | "rotate" | "share-rotate" | null>(null);
  const [draft, setDraft] = useState({ title: "", startDate: "", endDate: "" });
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [pendingEvent, setPendingEvent] = useState(false);
  const [name, setName] = useState("");
  const [incomingSecret, setIncomingSecret] = useState("");
  const joinSecret = useRef("");
  const [copied, setCopied] = useState("");
  const [viewKeyRecovery, setViewKeyRecovery] = useState(false);
  const [hasViewKey, setHasViewKey] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const draftId = useRef("");
  const root = cid ? `/api/calendars/${encodeURIComponent(cid)}` : "";

  const getToday = useCallback(() => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${v.year}-${v.month}-${v.day}`;
  }, []);

  const load = useCallback(async (calendarId: string, token?: string, setBusyState = false, explicitViewKey?: string): Promise<boolean> => {
    if (setBusyState) setBusy(true); else setLoading(true);
    setError("");
    try {
      let next: CalendarData;
      let viewKey = explicitViewKey || localStorage.getItem(viewKeyKey(calendarId)) || new URLSearchParams(window.location.search).get("k") || undefined;
      const getCalendar = () => request<CalendarData>(`/api/calendars/${encodeURIComponent(calendarId)}`, { headers: viewKey ? { "X-View-Key": viewKey } : {} });
      let candidateData: CalendarData | null = null;
      const candidateViewKey = localStorage.getItem(pendingViewKeyKey(calendarId));
      if (candidateViewKey) {
        try {
          candidateData = await request<CalendarData>(`/api/calendars/${encodeURIComponent(calendarId)}`, { headers: { "X-View-Key": candidateViewKey } });
          viewKey = candidateViewKey; localStorage.setItem(viewKeyKey(calendarId), candidateViewKey); localStorage.removeItem(pendingViewKeyKey(calendarId)); setViewKeyRecovery(false);
        } catch (pendingError) {
          if ((pendingError as Error & { status?: number }).status !== 404) throw pendingError;
          setViewKeyRecovery(true);
        }
      }
      if (token) {
        await request<{ member: Member }>(`/api/calendars/${encodeURIComponent(calendarId)}/session`, { method: "POST", body: JSON.stringify({ secret: token }) });
        localStorage.removeItem(pendingTokenKey(calendarId));
        next = await getCalendar();
      } else {
        next = candidateData || await getCalendar();
        const pending = localStorage.getItem(pendingTokenKey(calendarId));
        if (pending) {
          try { await request(`/api/calendars/${encodeURIComponent(calendarId)}/session`, { method: "POST", body: JSON.stringify({ secret: pending }) }); localStorage.setItem(tokenKey(calendarId), pending); localStorage.removeItem(pendingTokenKey(calendarId)); next = await getCalendar(); }
          catch (pendingError) { if ((pendingError as Error & { status?: number }).status !== 401) throw pendingError; }
        }
        const saved = typeof localStorage !== "undefined" ? localStorage.getItem(tokenKey(calendarId)) || undefined : undefined;
        if (saved && !next.me) {
          try {
            await request<{ member: Member }>(`/api/calendars/${encodeURIComponent(calendarId)}/session`, { method: "POST", body: JSON.stringify({ secret: saved }) });
            next = await getCalendar();
          } catch (restoreError) {
            if ((restoreError as Error & { status?: number }).status === 401) localStorage.removeItem(tokenKey(calendarId));
            else throw restoreError;
          }
        }
      }
      if (viewKey && new URLSearchParams(window.location.search).get("k") === viewKey) localStorage.setItem(viewKeyKey(calendarId), viewKey);
      if (candidateData) history.replaceState(null, "", sharePath(calendarId, candidateViewKey || undefined));
      setHasViewKey(!next.calendar.viewKeyRequired || Boolean(viewKey || localStorage.getItem(viewKeyKey(calendarId))));
      setData(next);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "カレンダーを読み込めませんでした。"); return false; }
    finally { setLoading(false); setBusy(false); }
  }, []);

  const closeModal = useCallback(() => { if (busy) return; if (modal === "switch") { const currentKey = new URLSearchParams(window.location.search).get("k") || localStorage.getItem(viewKeyKey(cid)) || undefined; history.replaceState(null, "", sharePath(cid, currentKey)); setModal(null); void load(cid); return; } setModal(null); setError(""); }, [busy, cid, load, modal]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search); const initial = params.get("c") || "";
    const incomingViewKey = params.get("k") || "";
    const hash = window.location.hash;
    const incoming = new URLSearchParams(hash.slice(1)).get("person") || "";
    // The client URL and Tokyo-local date are browser inputs unavailable to the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCid(initial); const now = getToday(); setToday(now); setMonth(now); setSelected(now);
    setHasViewKey(Boolean(incomingViewKey || localStorage.getItem(viewKeyKey(initial))));
    if (!initial) { setLoading(false); return; }
    if (incoming) {
      const existing = localStorage.getItem(tokenKey(initial));
      if (existing && existing !== incoming) { setIncomingSecret(incoming); setModal("switch"); setLoading(false); return; }
      void (async () => { if (await load(initial, incoming, false, incomingViewKey || undefined)) { localStorage.setItem(tokenKey(initial), incoming); history.replaceState(null, "", sharePath(initial, localStorage.getItem(viewKeyKey(initial)) || undefined)); } })();
    } else {
      void (async () => {
        const saved = localStorage.getItem(tokenKey(initial));
        const pending = localStorage.getItem(pendingTokenKey(initial));
        if (pending) {
          const recovered = await load(initial, pending, false, incomingViewKey || undefined);
          if (!recovered && saved) await load(initial, saved, false, incomingViewKey || undefined);
        } else if (saved) await load(initial, saved, false, incomingViewKey || undefined);
        else await load(initial, undefined, false, incomingViewKey || undefined);
      })();
    }
  }, [getToday, load]);

  useEffect(() => {
    if (!cid || !data) return;
    const refresh = () => { if (document.visibilityState === "visible") void load(cid); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [cid, data, load]);

  useEffect(() => {
    if (!modal) return;
    const before = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => (inputRef.current || dialogRef.current)?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (!busy) closeModal(); return; }
      if (e.key !== "Tab") return;
      const items = dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
      if (!items?.length) { e.preventDefault(); dialogRef.current?.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(timer); document.removeEventListener("keydown", onKey); before?.focus(); };
  }, [modal, busy, closeModal]);

  const visibleEvents = useMemo(() => (data?.events || []).filter((e) => !muted.includes(e.memberId)), [data, muted]);
  const days = useMemo(() => {
    if (!month) return [];
    const d = fromIso(month); d.setUTCDate(1); const offset = d.getUTCDay(); d.setUTCDate(1 - offset);
    return Array.from({ length: 42 }, (_, i) => { const x = new Date(d); x.setUTCDate(d.getUTCDate() + i); return iso(x); });
  }, [month]);
  const agenda = useMemo(() => visibleEvents.filter((e) => isBetween(selected, e.startDate, e.endDate)).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title)), [visibleEvents, selected]);

  function clearPersonHash() { history.replaceState(null, "", sharePath(cid, localStorage.getItem(viewKeyKey(cid)) || undefined)); }
  async function createCalendar(e: React.FormEvent) {
    e.preventDefault(); if (!createName.trim() || busy) return; setBusy(true); setError("");
    try { const key = makeToken(); const result = await request<{ calendar: { id: string; name: string } }>("/api/calendars", { method: "POST", body: JSON.stringify({ name: createName.trim(), viewKey: key }) });
      localStorage.setItem(viewKeyKey(result.calendar.id), key); history.replaceState(null, "", sharePath(result.calendar.id, key)); setCid(result.calendar.id); setCreateName(""); await load(result.calendar.id, undefined, false, key);
    } catch (e) { setError(e instanceof Error ? e.message : "カレンダーを作成できませんでした。"); } finally { setBusy(false); }
  }
  function startEvent(day = selected, endDate = day) {
    if (busy || loading) return;
    draftId.current = makeUuid();
    setEditing(null); setDraft({ title: "", startDate: day, endDate });
    setPendingEvent(!data?.me); setModal(data?.me ? "event" : "join"); setName("");
  }
  function editEvent(event: CalendarEvent) { if (event.memberId !== data?.me?.id) return; setEditing(event); setDraft({ title: event.title, startDate: event.startDate, endDate: event.endDate }); setModal("event"); }
  async function join(e: React.FormEvent) {
    e.preventDefault(); if (busy || !name.trim()) return; setBusy(true); setError("");
    const token = joinSecret.current || makeToken(); joinSecret.current = token;
    const key = tokenKey(cid); const previous = localStorage.getItem(key);
    localStorage.setItem(key, token);
    try { await request<{ member: Member }>(`${root}/members`, { method: "POST", body: JSON.stringify({ name: name.trim(), secret: token }) }); await load(cid, token); setModal(pendingEvent ? "event" : null); setPendingEvent(false); joinSecret.current = ""; }
    catch (e) {
      if ((e as Error & { status?: number }).status !== undefined) {
        if (previous) localStorage.setItem(key, previous); else localStorage.removeItem(key);
      }
      setError(e instanceof Error ? e.message : "参加できませんでした。");
    }
    finally { setBusy(false); }
  }
  async function saveEvent(e: React.FormEvent) {
    e.preventDefault(); if (busy || !draft.title.trim()) return; setBusy(true); setError("");
    const values = { title: draft.title.trim(), startDate: draft.startDate, endDate: draft.endDate };
    const body = editing ? { ...values, version: editing.version } : { id: draftId.current, ...values };
    try { await request<{ event: CalendarEvent }>(editing ? `${root}/events/${encodeURIComponent(editing.id)}` : `${root}/events`, { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) }); await load(cid); setModal(null); }
    catch (e) { const status = (e as Error & { status?: number }).status; setError(status === 409 ? "この予定は別の端末で更新されました。最新の内容を読み直してから編集してください。" : e instanceof Error ? e.message : "保存できませんでした。"); }
    finally { setBusy(false); }
  }
  async function deleteEvent() {
    if (!editing || busy) return; setBusy(true); setError("");
    try { await request(`${root}/events/${encodeURIComponent(editing.id)}`, { method: "DELETE", body: JSON.stringify({ version: editing.version }) }); await load(cid); setModal(null); }
    catch (e) { const status = (e as Error & { status?: number }).status; setError(status === 409 ? "予定が更新されています。読み直してから削除してください。" : e instanceof Error ? e.message : "削除できませんでした。"); }
    finally { setBusy(false); }
  }
  async function switchToIncoming() {
    if (busy) return; setBusy(true);
    const ok = await load(cid, incomingSecret);
    if (ok) { localStorage.setItem(tokenKey(cid), incomingSecret); clearPersonHash(); setIncomingSecret(""); setModal(null); }
  }
  async function rotatePersonalLink() {
    if (busy || !data?.me) return;
    setBusy(true); setError("");
    try {
      const secret = localStorage.getItem(pendingTokenKey(cid)) || makeToken();
      // Save before sending: an interrupted response must not lose the only valid key.
      localStorage.setItem(pendingTokenKey(cid), secret);
      await request(`${root}/session`, { method: "PATCH", body: JSON.stringify({ confirm: true, secret }) });
      localStorage.setItem(tokenKey(cid), secret);
      localStorage.removeItem(pendingTokenKey(cid));
      clearPersonHash(); setCopied(""); setModal("settings");
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && [400, 403, 429, 503].includes(status)) localStorage.removeItem(pendingTokenKey(cid));
      setError(e instanceof Error ? e.message : "再発行できませんでした。再読み込みして状態を確認してください。");
    } finally { setBusy(false); }
  }
  async function rotateShareLink() {
    if (busy || !data?.me) return;
    setBusy(true); setError("");
    const key = localStorage.getItem(pendingViewKeyKey(cid)) || makeToken();
    const previous = localStorage.getItem(viewKeyKey(cid)) || undefined;
    localStorage.setItem(pendingViewKeyKey(cid), key);
    try {
      await request(`${root}/share`, { method: "PATCH", body: JSON.stringify({ confirm: true, key, ...(previous ? { expectedKey: previous } : {}) }) });
      localStorage.setItem(viewKeyKey(cid), key); localStorage.removeItem(pendingViewKeyKey(cid)); setHasViewKey(true); setViewKeyRecovery(false); history.replaceState(null, "", sharePath(cid, key)); setCopied(""); setModal("settings");
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && [400, 403, 429, 503].includes(status)) localStorage.removeItem(pendingViewKeyKey(cid));
      if (status === 409) { localStorage.removeItem(pendingViewKeyKey(cid)); localStorage.removeItem(viewKeyKey(cid)); setHasViewKey(false); }
      setError(status === 409 ? "別の端末で共有リンクが再発行されました。読み直してください。" : e instanceof Error ? e.message : "再発行できませんでした。再読み込み後、候補キーの再送をご確認ください。");
    } finally { setBusy(false); }
  }
  async function copyLink(personal = false) {
    const secret = localStorage.getItem(tokenKey(cid));
    const viewKey = localStorage.getItem(viewKeyKey(cid));
    if (!personal && !viewKey && data?.calendar.viewKeyRequired) { setError("この端末には共有リンクのキーがありません。"); return; }
    if (personal && !secret) { setError("この端末には個人リンクが保存されていません。保管している個人リンクから開き直してください。"); return; }
    const url = `${window.location.origin}${sharePath(cid, viewKey || undefined)}${personal && secret ? `#person=${encodeURIComponent(secret)}` : ""}`;
    try { await navigator.clipboard.writeText(url); setCopied(personal ? "personal" : "shared"); window.setTimeout(() => setCopied(""), 1800); }
    catch { setError("リンクをコピーできませんでした。ブラウザーの設定をご確認ください。"); }
  }

  if (!cid) return <main className="welcome"><div className="welcome-art"><div className="art-note note-one">みんなの予定</div><div className="art-note note-two">6.12<br/><span>木</span></div><div className="art-note note-three"><span className="dot terracotta"/> おでかけ</div><div className="art-sun"/></div><section className="welcome-card"><div className="brand"><span className="brand-mark"><CalendarDays size={17}/></span><span>うちわカレンダー</span></div><p className="eyebrow">OUR DAYS, TOGETHER</p><h1>予定をひとつの場所に。</h1><p className="welcome-copy">家族や友だちと、気軽に予定を共有。<br/>予定名と日付だけで、気軽に共有できます。</p><form onSubmit={createCalendar} className="create-form"><label htmlFor="calendar-name">カレンダーの名前</label><div className="input-row"><input id="calendar-name" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="例：家族の予定" maxLength={40} required/><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17}/> : <ArrowRight size={17}/>}<span>作成する</span></button></div></form>{error && <p role="alert" className="inline-error">{error}</p>}<p className="privacy-note"><LockKeyhole size={14}/> アカウント登録なしで使えます</p></section></main>;

  return <main className="app-shell">
    <header className="topbar"><Link href="/?" className="brand" onClick={() => { setCid(""); setData(null); setMuted([]); setError(""); }}><span className="brand-mark"><CalendarDays size={17}/></span><span>うちわカレンダー</span></Link><div className="topbar-right"><button className="icon-button refresh-button" onClick={() => void load(cid, undefined, true)} aria-label="カレンダーを更新"><RefreshCw size={16} className={busy ? "spin" : ""}/></button><button className="share-button" onClick={() => void copyLink()} disabled={!hasViewKey} title={!hasViewKey ? "この端末には共有リンクのキーがありません" : undefined}><Copy size={15}/><span>{copied === "shared" ? "コピーしました" : "共有リンク"}</span></button><button className="icon-button" onClick={() => setModal("settings")} aria-label="設定"><Settings2 size={18}/></button></div></header>
    <div className="page-wrap"><section className="calendar-heading"><div><p className="eyebrow">みんなのカレンダー</p><h1>{data?.calendar.name || "カレンダー"}</h1></div>{data?.me ? <button className="me-chip" onClick={() => setModal("settings")}><span className="avatar" style={{ background: data.me.color }}>{data.me.name.slice(0, 1)}</span><span>{data.me.name}</span><ChevronDown size={14}/></button> : <button className="join-button" onClick={() => { setPendingEvent(false); setModal("join"); }}><Users size={16}/> 参加する</button>}</section>
      {error && !modal && <div role="alert" className="error-banner">{error}<button onClick={() => setError("")}>閉じる</button></div>}
      <div className="workspace"><section className="calendar-card"><div className="month-toolbar"><div className="month-title"><h2>{month ? fmtMonth.format(fromIso(month)) : ""}</h2><span className="month-tag">共有カレンダー</span></div><div className="month-actions"><button className="today-button" onClick={() => { setMonth(today); setSelected(today); }}>今日</button><button className="icon-button nav-button" aria-label="前の月" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={18}/></button><button className="icon-button nav-button" aria-label="次の月" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={18}/></button></div></div>
        <CalendarMonth days={days} month={month} today={today} selected={selected} events={visibleEvents} members={data?.members || []} disabled={busy || loading} onSelect={setSelected} onCreate={startEvent} onNavigateMonth={direction => setMonth(current => shiftMonth(current, direction))}/><div className="calendar-foot"><span><span className="today-legend"/> 今日</span><span className="calendar-help"><span className="desktop-calendar-help">ドラッグで期間選択・ダブルクリックで予定追加</span><span className="mobile-calendar-help">左右スワイプで月移動・長押ししてドラッグで期間選択</span></span></div></section>
        <aside className="agenda-card"><div className="agenda-head"><div><p className="eyebrow">DAY AGENDA</p><h2>{selected ? fmtDay.format(fromIso(selected)) : ""}</h2></div><button className="add-button" onClick={() => startEvent()} aria-label="予定を追加"><Plus size={18}/></button></div>
          {loading ? <div className="agenda-state"><LoaderCircle className="spin" size={21}/><span>読み込み中…</span></div> : agenda.length ? <div className="agenda-list">{agenda.map((event) => { const member = data?.members.find((m) => m.id === event.memberId); const owned = event.memberId === data?.me?.id; return <article key={event.id} className="agenda-event" style={{ "--member-color": member?.color || "#bd6749" } as React.CSSProperties}><span className="agenda-event-bar"/><div className="agenda-event-body"><h3>{event.title}</h3><p><span className="member-dot" style={{ background: member?.color }}/>{member?.name || "メンバー"}<span className="date-range">{event.startDate === event.endDate ? "" : `${event.startDate.slice(5).replace("-", "/")} – ${event.endDate.slice(5).replace("-", "/")}`}</span></p></div>{owned && <button className="edit-button" aria-label={`${event.title}を編集`} onClick={() => editEvent(event)}><Pencil size={15}/></button>}</article>; })}</div> : <div className="agenda-empty"><div className="empty-icon"><CalendarDays size={20}/></div><h3>予定はありません</h3><p>この日に決まっている予定は<br/>まだ登録されていません。</p></div>}
          <button className="agenda-add" onClick={() => startEvent()}><Plus size={16}/> この日に予定を追加</button>
          <div className="member-panel"><div className="member-panel-heading"><h3>メンバー</h3><span>{data?.members.length || 0}</span>{!data?.me && <button className="text-button" onClick={() => { setPendingEvent(false); setModal("join"); }}>参加</button>}</div>{data?.members.length ? <div className="member-list">{data.members.map((member) => <button key={member.id} className={`member-row ${muted.includes(member.id) ? "member-muted" : ""}`} onClick={() => setMuted((old) => old.includes(member.id) ? old.filter((id) => id !== member.id) : [...old, member.id])} aria-pressed={!muted.includes(member.id)}><span className="avatar small" style={{ background: member.color }}>{member.name.slice(0, 1)}</span><span className="member-name">{member.name}{member.id === data.me?.id ? <small>あなた</small> : null}</span><span className="member-color" style={{ background: member.color }}/></button>)}</div> : <p className="no-members">最初のメンバーとして参加できます。</p>}</div>
        </aside></div><footer className="app-footer"><span>うちわカレンダー <span className="footer-sep">·</span> みんなの予定を、ひとつに。</span><button onClick={() => setModal("settings")}><CircleHelp size={14}/> 使い方・設定</button></footer>
    </div>
    {modal && <div className="modal-backdrop" onMouseDown={(e) => { if (!busy && e.target === e.currentTarget) closeModal(); }}><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={dialogRef} tabIndex={-1}>
      <button className="dialog-close" aria-label="閉じる" onClick={closeModal} disabled={busy}><X size={18}/></button>
      {modal === "join" && <><div className="dialog-icon"><Users size={20}/></div><p className="eyebrow">JOIN THE CALENDAR</p><h2 id="dialog-title">メンバーとして参加</h2><p className="dialog-copy">名前を登録すると、予定にあなたの色が付きます。登録時にこのブラウザー用の個人リンクを作成します。</p><form onSubmit={join}><label htmlFor="member-name">表示名</label><input ref={inputRef} id="member-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：さくら" maxLength={40} required/><div className="dialog-actions"><button type="button" className="secondary-button" onClick={closeModal} disabled={busy}>あとで</button><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17}/> : <ArrowRight size={17}/>}参加する</button></div></form>{error && <p className="inline-error" role="alert">{error}</p>}</>}
      {modal === "event" && <><div className="dialog-icon"><CalendarDays size={20}/></div><p className="eyebrow">{editing ? "EDIT EVENT" : "NEW EVENT"}</p><h2 id="dialog-title">{editing ? "予定を編集" : "予定を追加"}</h2><form onSubmit={saveEvent}><label htmlFor="event-title">予定の名前</label><input ref={inputRef} id="event-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="例：公園でピクニック" maxLength={100} required/><div className="date-fields"><div><label htmlFor="event-start">開始日</label><input id="event-start" type="date" value={draft.startDate} onInput={(e) => { const value = e.currentTarget.value; setDraft((current) => ({ ...current, startDate: value, endDate: current.endDate < value ? value : current.endDate })); }} onChange={(e) => setDraft({ ...draft, startDate: e.target.value, endDate: draft.endDate < e.target.value ? e.target.value : draft.endDate })} required/></div><div><label htmlFor="event-end">終了日</label><input id="event-end" type="date" value={draft.endDate} min={draft.startDate} onInput={(e) => { const value = e.currentTarget.value; setDraft((current) => ({ ...current, endDate: value })); }} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} required/></div></div><p className="form-hint">終日予定です。1日だけなら開始日と終了日を同じ日にします。</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions">{editing && <button type="button" className="delete-button" onClick={() => setModal("delete")} disabled={busy}><Trash2 size={16}/>削除</button>}<button type="button" className="secondary-button" onClick={closeModal} disabled={busy}>キャンセル</button><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>}保存する</button></div></form></>}
      {modal === "delete" && <><div className="dialog-icon danger"><Trash2 size={20}/></div><p className="eyebrow">DELETE EVENT</p><h2 id="dialog-title">予定を削除しますか？</h2><p className="dialog-copy">「{editing?.title}」{editing?.startDate === editing?.endDate ? `（${editing?.startDate}）` : `（${editing?.startDate} ～ ${editing?.endDate}）`}をカレンダーから削除します。この操作は取り消せません。</p>{error && <p role="alert" className="inline-error">{error}</p>}<div className="dialog-actions"><button className="secondary-button" onClick={() => setModal("event")} disabled={busy}>キャンセル</button><button className="danger-button" onClick={deleteEvent} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16}/> : <Trash2 size={16}/>}削除する</button></div></>}
      {modal === "settings" && <><div className="dialog-icon"><Settings2 size={20}/></div><p className="eyebrow">YOUR SETTINGS</p><h2 id="dialog-title">共有と設定</h2><p className="dialog-copy">みんなで見る共有リンクと、あなたの参加情報を含む個人リンクがあります。</p><div className="link-option"><div className="link-icon"><Users size={17}/></div><div><strong>共有リンク</strong><p>{!hasViewKey && data?.calendar.viewKeyRequired ? "この端末には共有キーがないためコピーできません。" : "カレンダーを見たり、参加したりできます。"}</p></div><button className="copy-link-button" onClick={() => void copyLink()} disabled={!hasViewKey} title={!hasViewKey ? "この端末には共有リンクのキーがありません" : undefined}>{copied === "shared" ? <Check size={15}/> : <Copy size={15}/>}{copied === "shared" ? "コピー済み" : "コピー"}</button></div>{viewKeyRecovery && <p className="form-hint">共有リンクの再発行が届いていない可能性があります。読み直すか、設定から同じ候補キーを再送してください。</p>}{data?.me && <div className="link-option personal"><div className="link-icon"><LockKeyhole size={17}/></div><div><strong>あなたの個人リンク</strong><p>あなた専用のリンクです。誰にも共有しないでください。</p></div><button className="copy-link-button" onClick={() => void copyLink(true)}>{copied === "personal" ? <Check size={15}/> : <Copy size={15}/>}{copied === "personal" ? "コピー済み" : "コピー"}</button></div>}{data?.me ? <div className="settings-member"><span className="avatar" style={{ background: data.me.color }}>{data.me.name.slice(0, 1)}</span><div><strong>{data.me.name}</strong><small>このブラウザーに参加情報を保存しています</small></div></div> : <><p className="form-hint">個人リンクはメンバー参加後に発行されます。</p><button className="join-button full-join" onClick={() => { setModal("join"); setPendingEvent(false); }}>メンバーとして参加</button></>}{data?.me && <button className="delete-button" onClick={() => { setError(""); setModal("share-rotate"); }}>共有リンクを再発行</button>}{data?.me && <button className="delete-button" onClick={() => { setError(""); setModal("rotate"); }}>個人リンクを再発行</button>}<div className="dialog-actions"><button className="secondary-button" onClick={closeModal} disabled={busy}>閉じる</button></div>{error && <p className="inline-error" role="alert">{error}</p>}</>}
      {modal === "switch" && <><div className="dialog-icon"><LockKeyhole size={20}/></div><p className="eyebrow">PERSONAL LINK</p><h2 id="dialog-title">参加者を切り替えますか？</h2><p className="dialog-copy">このブラウザーには別のメンバーの参加情報が保存されています。リンクの参加者に切り替えると、このブラウザーでの予定編集者が変わります。</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="secondary-button" onClick={closeModal} disabled={busy}>今の参加者を使う</button><button className="primary-button" onClick={() => void switchToIncoming()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16}/> : null}切り替える</button></div></>}
      {modal === "share-rotate" && <><div className="dialog-icon danger"><LockKeyhole size={20}/></div><h2 id="dialog-title">共有リンクを再発行しますか？</h2><p className="dialog-copy">古い共有リンクでの匿名閲覧と新規参加を止め、新しいキーへ切り替えます。すでに参加している人のCookieと個人リンクは引き続き使えます。</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => setModal("settings")}>キャンセル</button><button className="danger-button" disabled={busy} onClick={() => void rotateShareLink()}>{busy ? <LoaderCircle className="spin" size={16}/> : <LockKeyhole size={16}/>}再発行する</button></div></>}
      {modal === "rotate" && <><div className="dialog-icon danger"><LockKeyhole size={20}/></div><h2 id="dialog-title">個人リンクを再発行しますか？</h2><p className="dialog-copy">以前の個人リンクと、ほかの端末の参加情報はすべて無効になります。予定・名前・色はそのまま引き継ぎます。再発行後に新しい個人リンクを保管してください。</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => setModal("settings")}>キャンセル</button><button className="danger-button" disabled={busy} onClick={() => void rotatePersonalLink()}>{busy ? <LoaderCircle className="spin" size={16}/> : <LockKeyhole size={16}/>}再発行して以前のリンクを無効にする</button></div></>}
    </div></div>}
  </main>;
}

function shiftMonth(date: string, amount: number) {
  if (!date) return date; const d = fromIso(date); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + amount); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return iso(d);
}
