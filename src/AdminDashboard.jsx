import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity, Users, Globe, Wallet as WalletIcon, Eye, RefreshCw, ToggleLeft, ToggleRight,
  Save, AlertCircle, CheckCircle, Loader2, Wifi, Clock, ArrowUpRight,
} from 'lucide-react';
import { api } from './api';

const FLAG_META = {
  mint_enabled:     { label: 'Mint button',         desc: 'Allow users to mint new inscriptions.', kind: 'toggle' },
  listing_enabled:  { label: 'Create Listing',      desc: 'Allow sellers to create new listings on the marketplace.', kind: 'toggle' },
  maintenance_mode: { label: 'Maintenance banner',  desc: 'Show a site-wide maintenance banner.', kind: 'banner' },
  announcement:     { label: 'Announcement',        desc: 'Show a custom announcement banner.', kind: 'banner' },
};

const FLAG_ORDER = ['mint_enabled', 'listing_enabled', 'maintenance_mode', 'announcement'];

const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtAddr = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
const fmtTime = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(ts)));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const fmtDay = (ts) => new Date(Number(ts) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function AdminDashboard({ account, signer }) {
  const [stats, setStats] = useState(null);
  const [flags, setFlags] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingKey, setSavingKey] = useState('');
  const [toast, setToast] = useState(null);
  const [draft, setDraft] = useState({}); // local edits before save

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, f] = await Promise.all([api.adminStats(), api.flags()]);
      setStats(s);
      setFlags(f.flags || {});
    } catch (err) {
      setToast({ type: 'error', message: err.message });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 10000); // refresh every 10s
    return () => clearInterval(id);
  }, [load]);

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  };

  const saveFlag = async (key, patch) => {
    if (!signer) {
      showToast('error', 'Wallet signer not available. Reconnect your wallet.');
      return;
    }
    setSavingKey(key);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const message = `monad-admin:${ts}`;
      const signature = await signer.signMessage(message);
      const current = flags[key] || { enabled: false, value: '' };
      const merged = { ...current, ...patch };
      await api.setFlag({
        address: account,
        message,
        signature,
        key,
        enabled: !!merged.enabled,
        value: merged.value || '',
      });
      showToast('success', `Updated "${FLAG_META[key]?.label || key}"`);
      setDraft(d => { const c = { ...d }; delete c[key]; return c; });
      await load();
    } catch (err) {
      showToast('error', err.message || 'Failed to save flag');
    } finally {
      setSavingKey('');
    }
  };

  const dailyMax = useMemo(() => {
    const arr = stats?.daily || [];
    return arr.reduce((m, d) => Math.max(m, d.visits || 0), 0) || 1;
  }, [stats]);

  if (loading) {
    return (
      <div className="admin-dashboard">
        <div className="admin-loading"><Loader2 className="spin" size={28} /> Loading dashboard…</div>
      </div>
    );
  }

  return (
    <div className="admin-dashboard">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="admin-head">
        <div>
          <span className="admin-eyebrow">ADMIN PANEL</span>
          <h1>Dashboard</h1>
          <p>Live analytics, visitor activity, and feature controls.</p>
        </div>
        <div className="admin-head-actions">
          <span className="admin-live"><span /> LIVE</span>
          <button className="admin-btn ghost" onClick={load} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {toast && (
        <div className={`admin-toast ${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* ── KPI cards ───────────────────────────────────────────────── */}
      <div className="admin-kpis">
        <div className="admin-kpi accent-green">
          <div className="admin-kpi-icon"><Wifi size={18} /></div>
          <span className="admin-kpi-label">Online now</span>
          <strong>{fmtNum(stats?.realtime?.online_now)}</strong>
          <span className="admin-kpi-sub">last 5 min</span>
        </div>
        <div className="admin-kpi accent-blue">
          <div className="admin-kpi-icon"><Eye size={18} /></div>
          <span className="admin-kpi-label">Today's visits</span>
          <strong>{fmtNum(stats?.realtime?.today_visits)}</strong>
          <span className="admin-kpi-sub">since midnight</span>
        </div>
        <div className="admin-kpi accent-purple">
          <div className="admin-kpi-icon"><Activity size={18} /></div>
          <span className="admin-kpi-label">Total visits</span>
          <strong>{fmtNum(stats?.totals?.visits)}</strong>
          <span className="admin-kpi-sub">all-time</span>
        </div>
        <div className="admin-kpi accent-orange">
          <div className="admin-kpi-icon"><Users size={18} /></div>
          <span className="admin-kpi-label">Unique sessions</span>
          <strong>{fmtNum(stats?.totals?.sessions)}</strong>
          <span className="admin-kpi-sub">browser sessions</span>
        </div>
        <div className="admin-kpi accent-cyan">
          <div className="admin-kpi-icon"><Globe size={18} /></div>
          <span className="admin-kpi-label">Unique IPs</span>
          <strong>{fmtNum(stats?.totals?.unique_ips)}</strong>
          <span className="admin-kpi-sub">anonymized</span>
        </div>
        <div className="admin-kpi accent-pink">
          <div className="admin-kpi-icon"><WalletIcon size={18} /></div>
          <span className="admin-kpi-label">Wallets</span>
          <strong>{fmtNum(stats?.totals?.unique_wallets)}</strong>
          <span className="admin-kpi-sub">connected</span>
        </div>
      </div>

      {/* ── Feature flag toggles ────────────────────────────────────── */}
      <section className="admin-section">
        <div className="admin-section-head">
          <h2>Feature controls</h2>
          <span className="admin-section-sub">Changes apply instantly across all clients</span>
        </div>
        <div className="admin-flags">
          {FLAG_ORDER.map(key => {
            const meta = FLAG_META[key];
            const flag = flags[key] || { enabled: false, value: '' };
            const local = draft[key] || flag;
            const dirty = draft[key] && (
              draft[key].enabled !== flag.enabled || draft[key].value !== flag.value
            );
            return (
              <div key={key} className={`admin-flag ${local.enabled ? 'on' : 'off'}`}>
                <div className="admin-flag-info">
                  <strong>{meta.label}</strong>
                  <span>{meta.desc}</span>
                  {flag.updated_by && (
                    <span className="admin-flag-meta">
                      <Clock size={10} /> {fmtTime(flag.updated_at)} by {fmtAddr(flag.updated_by)}
                    </span>
                  )}
                </div>
                <div className="admin-flag-controls">
                  <button
                    className={`admin-toggle ${local.enabled ? 'on' : 'off'}`}
                    onClick={() => {
                      const next = { ...local, enabled: !local.enabled };
                      // For pure toggles (no value editor), save instantly
                      if (meta.kind === 'toggle') {
                        saveFlag(key, { enabled: next.enabled });
                      } else {
                        setDraft(d => ({ ...d, [key]: next }));
                      }
                    }}
                    disabled={savingKey === key}
                  >
                    {local.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                    <span>{local.enabled ? 'ON' : 'OFF'}</span>
                  </button>
                  {meta.kind === 'banner' && (
                    <>
                      <input
                        className="admin-input"
                        placeholder="Banner message…"
                        value={local.value}
                        onChange={(e) => setDraft(d => ({ ...d, [key]: { ...local, value: e.target.value } }))}
                      />
                      <button
                        className="admin-btn primary sm"
                        disabled={!dirty || savingKey === key}
                        onClick={() => saveFlag(key, draft[key])}
                      >
                        {savingKey === key ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
                        Save
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Daily visits sparkline ──────────────────────────────────── */}
      <section className="admin-section">
        <div className="admin-section-head">
          <h2>Daily visits · last 30 days</h2>
        </div>
        <div className="admin-chart">
          {(stats?.daily || []).length === 0 ? (
            <div className="admin-empty">No data yet — visit traffic will appear here.</div>
          ) : (
            <div className="admin-chart-bars">
              {(stats?.daily || []).map(d => (
                <div key={d.day} className="admin-chart-bar" title={`${fmtDay(d.day)} · ${d.visits} visits · ${d.uniques} uniques`}>
                  <div className="admin-chart-bar-fill" style={{ height: `${(d.visits / dailyMax) * 100}%` }} />
                  <span className="admin-chart-bar-label">{fmtDay(d.day)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="admin-grid-2">
        {/* ── Top pages ────────────────────────────────────────────── */}
        <section className="admin-section">
          <div className="admin-section-head">
            <h2>Top pages · last 7 days</h2>
          </div>
          <div className="admin-table">
            <div className="admin-tr admin-th">
              <span>Path</span><span>Visits</span><span>Uniques</span>
            </div>
            {(stats?.by_path || []).slice(0, 10).map(r => (
              <div key={r.path} className="admin-tr">
                <span className="mono">{r.path}</span>
                <span className="mono right">{fmtNum(r.visits)}</span>
                <span className="mono right">{fmtNum(r.uniques)}</span>
              </div>
            ))}
            {(stats?.by_path || []).length === 0 && <div className="admin-empty sm">No page views yet.</div>}
          </div>
        </section>

        {/* ── Top wallets ──────────────────────────────────────────── */}
        <section className="admin-section">
          <div className="admin-section-head">
            <h2>Recent wallet connections</h2>
          </div>
          <div className="admin-table">
            <div className="admin-tr admin-th admin-tr-3">
              <span>Wallet</span><span>Visits</span><span>Last seen</span>
            </div>
            {(stats?.top_wallets || []).slice(0, 10).map(r => (
              <div key={r.wallet} className="admin-tr admin-tr-3">
                <span className="mono">{fmtAddr(r.wallet)}</span>
                <span className="mono right">{fmtNum(r.visits)}</span>
                <span className="mono right mut">{fmtTime(r.last_seen)}</span>
              </div>
            ))}
            {(stats?.top_wallets || []).length === 0 && <div className="admin-empty sm">No wallet connections yet.</div>}
          </div>
        </section>
      </div>

      {/* ── Live visit feed ─────────────────────────────────────────── */}
      <section className="admin-section">
        <div className="admin-section-head">
          <h2>Recent visits</h2>
          <span className="admin-section-sub">{(stats?.recent_visits || []).length} most recent</span>
        </div>
        <div className="admin-feed">
          {(stats?.recent_visits || []).slice(0, 30).map((v, i) => (
            <div key={`${v.ts}-${i}`} className="admin-feed-row">
              <span className="admin-feed-time mono mut">{fmtTime(v.ts)}</span>
              <span className="admin-feed-path mono">{v.path}</span>
              <span className="admin-feed-wallet mono mut">{v.wallet ? fmtAddr(v.wallet) : 'anonymous'}</span>
              <span className="admin-feed-ua mut" title={v.user_agent}>
                {(v.user_agent || '').split(' ')[0] || 'unknown'} <ArrowUpRight size={10} />
              </span>
            </div>
          ))}
          {(stats?.recent_visits || []).length === 0 && <div className="admin-empty">No recent activity.</div>}
        </div>
      </section>
    </div>
  );
}
