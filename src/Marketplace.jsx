import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ethers } from 'ethers';
import {
  ShoppingCart, Tag, Plus, X, Loader2,
  Wallet, TrendingUp, Layers, Activity, CheckCircle, AlertTriangle,
  ArrowRight, Search, Filter, Grid3x3, List as ListIcon, Sparkles, ArrowUpRight,
  Users, BarChart3, Flame,
} from 'lucide-react';
import { api } from './api';
import { MARKET_ABI, MARKET_CONTRACT_ADDRESS, FEE_PERCENT } from './marketAbi';

const fmtAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtMon = (n) => {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  if (v < 0.001) return v.toFixed(6);
  if (v < 1) return v.toFixed(4);
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
};

export default function Marketplace({ account, signer, tick = 'BOB', onBalanceChange, listingEnabled = true }) {
  const [listings, setListings] = useState([]);
  const [activity, setActivity] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showList, setShowList] = useState(false);
  const [filter, setFilter] = useState('all'); // all | mine | activity
  const [busy, setBusy] = useState(null); // listing id being acted on
  const [toast, setToast] = useState(null);
  // Premium UX state
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('price_asc');
  const [view, setView] = useState('grid'); // grid | list
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [holders, setHolders] = useState(null);

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  const refresh = useCallback(async () => {
    try {
      const [{ items }, s, act, tok] = await Promise.all([
        api.listings(tick, 100),
        api.marketStats(tick),
        api.marketActivity(tick, 50).catch(() => ({ items: [] })),
        api.token(tick).catch(() => null),
      ]);
      setListings(items || []);
      setStats(s);
      setActivity(act?.items || []);
      if (tok && tok.holders != null) setHolders(Number(tok.holders));
    } catch (err) {
      console.error('Marketplace load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [tick]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 12000);
    return () => clearInterval(t);
  }, [refresh]);

  // Sales-derived signals for hero
  const soldEvents = useMemo(
    () => activity.filter(e => e.kind === 'sold'),
    [activity]
  );
  const salesCount = soldEvents.length;
  const sparkPoints = useMemo(() => {
    return [...soldEvents]
      .reverse()
      .slice(-24)
      .map(e => Number(e.price_mon) / Math.max(1, Number(e.amount)))
      .filter(n => isFinite(n) && n > 0);
  }, [soldEvents]);

  const visible = useMemo(() => {
    let arr = listings;
    if (filter === 'mine' && account) {
      arr = arr.filter(l => l.seller.toLowerCase() === account.toLowerCase());
    }
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter(l =>
        String(l.amount).includes(q) ||
        l.seller.toLowerCase().includes(q) ||
        String(l.price_mon).includes(q) ||
        String(l.id).includes(q)
      );
    }
    const minN = priceMin === '' ? null : Number(priceMin);
    const maxN = priceMax === '' ? null : Number(priceMax);
    if (minN != null && !Number.isNaN(minN)) arr = arr.filter(l => Number(l.price_mon) >= minN);
    if (maxN != null && !Number.isNaN(maxN)) arr = arr.filter(l => Number(l.price_mon) <= maxN);
    arr = [...arr];
    switch (sort) {
      case 'price_asc':
        arr.sort((a, b) => (Number(a.price_mon) / Math.max(1, a.amount)) - (Number(b.price_mon) / Math.max(1, b.amount)));
        break;
      case 'price_desc':
        arr.sort((a, b) => (Number(b.price_mon) / Math.max(1, b.amount)) - (Number(a.price_mon) / Math.max(1, a.amount)));
        break;
      case 'amount_desc':
        arr.sort((a, b) => Number(b.amount) - Number(a.amount));
        break;
      case 'newest':
        arr.sort((a, b) => Number(b.created_ts || b.id) - Number(a.created_ts || a.id));
        break;
      default:
        break;
    }
    return arr;
  }, [listings, filter, account, search, priceMin, priceMax, sort]);

  const contract = useMemo(() => {
    if (!signer || !MARKET_CONTRACT_ADDRESS) return null;
    return new ethers.Contract(MARKET_CONTRACT_ADDRESS, MARKET_ABI, signer);
  }, [signer]);

  const handleBuy = async (listing) => {
    if (!account || !signer) {
      showToast('error', 'Connect your wallet first');
      return;
    }
    if (listing.seller.toLowerCase() === account.toLowerCase()) {
      showToast('error', "You can't buy your own listing");
      return;
    }
    if (!contract) {
      showToast('error', 'Marketplace contract not configured');
      return;
    }
    if (listing.onchain_id == null) {
      showToast('error', 'This listing is off-chain only and cannot be bought via the contract.');
      return;
    }
    setBusy(listing.id);
    try {
      const value = ethers.parseEther(String(listing.price_mon));
      const tx = await contract.buy(listing.onchain_id, { value });
      showToast('info', 'Payment sent. Waiting for confirmation…');
      await tx.wait();
      await api.confirmBuy(listing.id, account, tx.hash);
      showToast('success', `Bought ${listing.amount} ${listing.tick} — fee ${FEE_PERCENT}% paid`);
      refresh();
      // Trigger wallet balance refresh in parent
      onBalanceChange?.();
    } catch (err) {
      console.error(err);
      const msg = err?.shortMessage || err?.reason || err?.message || 'Buy failed';
      showToast('error', msg);
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async (listing) => {
    if (!account) return;
    setBusy(listing.id);
    try {
      if (contract && listing.onchain_id != null) {
        const tx = await contract.cancel(listing.onchain_id);
        showToast('info', 'Cancelling on-chain…');
        await tx.wait();
      }
      await api.cancelListing(listing.id, account);
      showToast('success', 'Listing cancelled');
      refresh();
      onBalanceChange?.();
    } catch (err) {
      const msg = err?.shortMessage || err?.reason || err?.message || 'Cancel failed';
      showToast('error', msg);
    } finally {
      setBusy(null);
    }
  };

  const contractMissing = !MARKET_CONTRACT_ADDRESS;

  return (
    <div className="market mp">
      {contractMissing && (
        <div className="market-banner">
          <AlertTriangle size={20} />
          <div>
            <strong>Marketplace contract not deployed yet.</strong>
            <p>
              Listing, buying, and cancelling are disabled until you deploy
              <code> MonadInscriptionMarket.sol </code>
              and set <code>VITE_MARKET_CONTRACT</code> in your <code>.env</code>.
              See <code>contracts/README.md</code> for the deploy steps.
            </p>
          </div>
        </div>
      )}
      {/* ── COMPACT HEADER ─────────────────────────────────── */}
      <section className="mp-header">
        <div className="mp-header-id">
          <div className="mp-header-text">
            <div className="mp-header-title-row">
              <h1 className="mp-title">Marketplace</h1>
              <span className="mp-chip mp-chip-verified" title="Verified collection">
                <CheckCircle size={11} /> Verified
              </span>
              <span className="mp-chip">MON-20</span>
              <span className="mp-chip mp-chip-hot"><Flame size={11} /> Trending</span>
            </div>
            <div className="mp-header-sub">
              Native MON-20 inscription marketplace on Monad
            </div>
          </div>
        </div>
        <div className="mp-header-actions">
          <button className="mp-btn ghost" onClick={refresh} disabled={loading} title="Refresh">
            <Loader2 size={13} className={loading ? 'spin' : ''} /> Refresh
          </button>
          <button
            className="mp-btn primary"
            onClick={() => setShowList(true)}
            disabled={contractMissing || !listingEnabled}
            title={!listingEnabled ? 'Listing creation is temporarily disabled' : (contractMissing ? 'Deploy the marketplace contract first' : undefined)}
          >
            <Tag size={13} /> {!listingEnabled ? 'Listing Paused' : 'List item'}
          </button>
        </div>
      </section>

      {/* ── METRIC STRIP ──────────────────────────────────── */}
      <section className="mp-metrics">
        <Metric label="Floor" value={stats ? fmtMon(stats.floor_unit_price) : '—'} unit="MON" icon={<Tag size={11} />} />
        <Metric label="Volume" value={stats ? fmtMon(stats.volume_mon) : '—'} unit="MON" icon={<TrendingUp size={11} />} />
        <Metric label="Sales" value={salesCount.toLocaleString()} icon={<BarChart3 size={11} />} />
        <Metric label="Listings" value={stats ? stats.active_listings : '—'} icon={<ShoppingCart size={11} />} />
        <Metric label="Listed" value={stats ? Number(stats.active_supply).toLocaleString() : '—'} unit={tick} icon={<Layers size={11} />} />
        <Metric label="Holders" value={holders != null ? Number(holders).toLocaleString() : '—'} icon={<Users size={11} />} />
        <div className="mp-metric mp-metric-spark">
          <div className="mp-metric-label">
            <TrendingUp size={11} /> Trend
            <span className="mp-metric-trend">
              {sparkPoints.length > 1
                ? (sparkPoints[sparkPoints.length - 1] >= sparkPoints[0]
                    ? <span className="up">▲</span>
                    : <span className="down">▼</span>)
                : null}
            </span>
          </div>
          <Sparkline points={sparkPoints} />
        </div>
      </section>

      {/* ── LIVE TICKER (thin) ────────────────────────────── */}
      <div className="mp-ticker-bar">
        <span className="mp-ticker-label"><span className="mp-pulse-dot" /> LIVE</span>
        <Ticker events={soldEvents.slice(0, 12)} tick={tick} />
      </div>

      {/* ── TOOLBAR ────────────────────────────────────────── */}
      <div className="mp-toolbar">
        <div className="mp-search">
          <Search size={14} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by amount, seller, listing #…"
          />
          {search && (
            <button className="mp-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="market-tabs mp-tabs">
          <button
            className={`market-tab ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All Listings
            {listings.length > 0 && <span className="market-tab-count">{listings.length}</span>}
          </button>
          <button
            className={`market-tab ${filter === 'mine' ? 'active' : ''}`}
            onClick={() => setFilter('mine')}
            disabled={!account}
          >My Listings</button>
          <button
            className={`market-tab ${filter === 'activity' ? 'active' : ''}`}
            onClick={() => setFilter('activity')}
          >
            <Activity size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
            Activity
            {activity.length > 0 && <span className="market-tab-count">{activity.length}</span>}
          </button>
        </div>
        <div className="mp-toolbar-right">
          <select className="mp-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="price_asc">Floor first ↑</option>
            <option value="price_desc">Highest unit price</option>
            <option value="amount_desc">Largest amount</option>
            <option value="newest">Recently listed</option>
          </select>
          <div className="mp-view">
            <button
              className={view === 'grid' ? 'active' : ''}
              onClick={() => setView('grid')}
              title="Grid view"
            ><Grid3x3 size={14} /></button>
            <button
              className={view === 'list' ? 'active' : ''}
              onClick={() => setView('list')}
              title="List view"
            ><ListIcon size={14} /></button>
          </div>
        </div>
      </div>

      {/* ── LAYOUT ─────────────────────────────────────────── */}
      <div className="mp-layout">
        <main className="mp-main">
          {filter === 'activity' ? (
            <ActivityPanel events={activity} loading={loading} />
          ) : loading ? (
            <div className={`mp-grid ${view}`}>
              {Array.from({ length: 8 }).map((_, i) => (
                <SkeletonCard key={i} view={view} />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="mp-empty">
              <ShoppingCart size={32} />
              <h3>{filter === 'mine'
                ? "You haven't listed anything yet."
                : `No ${tick} listings match your filters.`}</h3>
              <p>{filter === 'mine'
                ? 'Create your first listing to start earning MON.'
                : 'Try clearing filters or be the first to list.'}</p>
              <button
                className="mp-cta sm"
                onClick={() => setShowList(true)}
                disabled={contractMissing || !listingEnabled}
                title={!listingEnabled ? 'Listing creation is temporarily disabled' : undefined}
              >
                <Plus size={14} /> {!listingEnabled ? 'Listing Paused' : 'Create a listing'}
              </button>
            </div>
          ) : (
            <div className={`mp-grid ${view}`}>
              {view === 'list' && (
                <div className="mp-thead" role="row">
                  <span className="mp-th col-tok">Token</span>
                  <span className="mp-th col-amt">Amount</span>
                  <span className="mp-th col-price">Price</span>
                  <span className="mp-th col-unit">Unit</span>
                  <span className="mp-th col-rar">Tx</span>
                  <span className="mp-th col-sel">Seller</span>
                  <span className="mp-th col-time">Listed</span>
                  <span className="mp-th col-act"></span>
                </div>
              )}
              {visible.map(l => (
                <ListingCard
                  key={l.id}
                  listing={l}
                  account={account}
                  busy={busy === l.id}
                  view={view}
                  onBuy={() => handleBuy(l)}
                  onCancel={() => handleCancel(l)}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {showList && (
        <CreateListingModal
          account={account}
          signer={signer}
          contract={contract}
          tick={tick}
          onClose={() => setShowList(false)}
          onCreated={() => { setShowList(false); refresh(); showToast('success', 'Listing created'); }}
          onError={(m) => showToast('error', m)}
        />
      )}

      {toast && (
        <div className={`market-toast ${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle size={18} /> : null}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, unit, icon }) {
  return (
    <div className="mp-metric">
      <div className="mp-metric-label">{icon}{label}</div>
      <div className="mp-metric-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
    </div>
  );
}

function Sparkline({ points }) {
  if (!points || points.length < 2) {
    return <div className="mp-spark-empty">No sales yet</div>;
  }
  const W = 160, H = 32, P = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = (max - min) || 1;
  const step = (W - P * 2) / (points.length - 1);
  const xs = points.map((_, i) => P + i * step);
  const ys = points.map((v) => H - P - ((v - min) / range) * (H - P * 2));
  const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const fill = `${d} L${xs[xs.length - 1].toFixed(1)},${H} L${xs[0].toFixed(1)},${H} Z`;
  return (
    <svg className="mp-spark-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sparkStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#sparkFill)" />
      <path d={d} fill="none" stroke="url(#sparkStroke)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Ticker({ events, tick }) {
  return (
    <div className="mp-ticker">
      <div className="mp-ticker-label">
        <span className="mp-pulse-dot" /> LIVE SALES
      </div>
      <div className="mp-ticker-rail">
        {events.length === 0 ? (
          <div className="mp-ticker-empty">No sales yet — be the first to flip!</div>
        ) : (
          <div className="mp-ticker-track">
            {[...events, ...events].map((e, i) => (
              <span key={i} className="mp-ticker-item">
                <strong>{Number(e.amount).toLocaleString()} {tick}</strong>
                <span>·</span>
                <em>{fmtMon(e.price_mon)} MON</em>
                <span>·</span>
                <code>{fmtAddr(e.from)}</code>
                <ArrowRight size={11} />
                <code>{fmtAddr(e.to)}</code>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterSection({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`mp-filter-section ${open ? 'open' : ''}`}>
      <button className="mp-filter-section-head" onClick={() => setOpen(o => !o)}>
        <span>{title}</span>
        <span className="mp-filter-caret">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mp-filter-section-body">{children}</div>}
    </div>
  );
}

function FilterPanel({ priceMin, priceMax, onPriceChange, onClear, stats, soldEvents, tick }) {
  const avgUnit = soldEvents.length
    ? soldEvents.reduce((s, e) => s + Number(e.price_mon) / Math.max(1, Number(e.amount)), 0) / soldEvents.length
    : 0;
  return (
    <div className="mp-filter-panel">
      <div className="mp-filter-head">
        <h4><Filter size={14} /> Filters</h4>
        <button onClick={onClear}>Reset</button>
      </div>

      <FilterSection title="Status">
        <div className="mp-chips">
          <button className="active">Buy now</button>
          <button>On auction</button>
          <button>New</button>
          <button>Has offers</button>
        </div>
      </FilterSection>

      <FilterSection title="Price (MON)">
        <div className="mp-filter-range">
          <input
            type="number" min="0" step="any" placeholder="Min"
            value={priceMin}
            onChange={(e) => onPriceChange(e.target.value, priceMax)}
          />
          <span>—</span>
          <input
            type="number" min="0" step="any" placeholder="Max"
            value={priceMax}
            onChange={(e) => onPriceChange(priceMin, e.target.value)}
          />
        </div>
        <div className="mp-chips" style={{ marginTop: 8 }}>
          <button onClick={() => onPriceChange('', '0.5')}>{'< 0.5'}</button>
          <button onClick={() => onPriceChange('0.5', '2')}>0.5–2</button>
          <button onClick={() => onPriceChange('2', '10')}>2–10</button>
          <button onClick={() => onPriceChange('10', '')}>{'> 10'}</button>
        </div>
      </FilterSection>

      <FilterSection title="Collection stats" defaultOpen={false}>
        <div className="mp-filter-stats">
          <div><span>Avg sale unit</span><strong>{avgUnit ? fmtMon(avgUnit) : '—'} MON</strong></div>
          <div><span>Sales count</span><strong>{soldEvents.length.toLocaleString()}</strong></div>
          <div><span>Floor</span><strong>{stats ? `${fmtMon(stats.floor_unit_price)} MON` : '—'}</strong></div>
        </div>
      </FilterSection>

      <div className="mp-filter-promo">
        <Sparkles size={14} />
        <div>
          <strong>Top collection</strong>
          <p>{tick} is the most active MON-20 inscription on Monad right now.</p>
        </div>
      </div>
    </div>
  );
}

// Short tx-hash representation for blockchain-explorer style metadata.
const fmtTx = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '');

function listingHues(listing) {
  const seed = String(listing.list_tx_hash || `${listing.id}${listing.seller || ''}`).toLowerCase();
  const slice = seed.replace(/[^0-9a-f]/g, '').padEnd(8, '4');
  const a = parseInt(slice.slice(0, 4), 16) % 360;
  const b = (a + 60 + parseInt(slice.slice(4, 8), 16) % 140) % 360;
  return { a, b };
}

// VSCode-style inscription JSON preview rendered inside listing cards.
// Replaces the legacy gradient artwork with the actual on-chain payload
// so each card feels native to the mon-20 protocol.
function InscriptionCodePreview({ tick, amount, hue = 270 }) {
  const amtStr = String(Number(amount) || 0);
  const glowStyle = {
    background: `radial-gradient(60% 70% at 70% 20%, hsla(${hue}, 90%, 65%, 0.22), transparent 70%)`,
  };
  return (
    <div className="insc-preview">
      <div className="insc-preview-glow" style={glowStyle} />
      <div className="insc-preview-noise" aria-hidden="true" />
      <div className="insc-preview-chrome">
        <span className="dot r" /><span className="dot y" /><span className="dot g" />
        <span className="insc-preview-fname">inscription.json</span>
      </div>
      <pre className="insc-preview-code" aria-hidden="true">
        <span className="ln-row"><span className="ln">1</span><span className="tok pn">{'{'}</span></span>
        <span className="ln-row"><span className="ln">2</span>{'  '}<span className="tok k">"p"</span><span className="tok pn">: </span><span className="tok s">"mon-20"</span><span className="tok pn">,</span></span>
        <span className="ln-row"><span className="ln">3</span>{'  '}<span className="tok k">"op"</span><span className="tok pn">: </span><span className="tok s">"mint"</span><span className="tok pn">,</span></span>
        <span className="ln-row"><span className="ln">4</span>{'  '}<span className="tok k">"tick"</span><span className="tok pn">: </span><span className="tok s">"{tick}"</span><span className="tok pn">,</span></span>
        <span className="ln-row"><span className="ln">5</span>{'  '}<span className="tok k">"amt"</span><span className="tok pn">: </span><span className="tok n">"{amtStr}"</span></span>
        <span className="ln-row"><span className="ln">6</span><span className="tok pn">{'}'}</span></span>
      </pre>
      <div className="insc-preview-glass" aria-hidden="true" />
      <span className="insc-preview-tick">{tick}</span>
    </div>
  );
}

function ListingCard({ listing, account, busy, view, onBuy, onCancel }) {
  const isMine = account && listing.seller.toLowerCase() === account.toLowerCase();
  const unit = Number(listing.price_mon) / Math.max(1, Number(listing.amount));
  const hues = listingHues(listing);
  const artStyle = {
    background: `radial-gradient(120% 120% at 30% 20%, hsl(${hues.a}, 75%, 55%), hsl(${hues.b}, 65%, 28%) 70%, #0c0414)`,
  };

  if (view === 'list') {
    return (
      <div className="mp-row" role="row">
        <div className="mp-row-cell col-tok">
          <div className="mp-row-thumb" style={artStyle}>
            <span>{listing.tick}</span>
          </div>
          <div className="mp-row-tok">
            <strong>{listing.tick}</strong>
            <span className="mp-row-id">#{listing.id}</span>
          </div>
        </div>
        <div className="mp-row-cell col-amt mono">{Number(listing.amount).toLocaleString()}</div>
        <div className="mp-row-cell col-price mono">
          <strong>{fmtMon(listing.price_mon)}</strong><small> MON</small>
        </div>
        <div className="mp-row-cell col-unit mono mut">{fmtMon(unit)}</div>
        <div className="mp-row-cell col-rar mono mut" title={listing.list_tx_hash || ''}>
          {fmtTx(listing.list_tx_hash)}
        </div>
        <div className="mp-row-cell col-sel mono mut" title={listing.seller}>
          {fmtAddr(listing.seller)}{isMine && <span className="mp-row-mine">YOU</span>}
        </div>
        <div className="mp-row-cell col-time mut">{listing.created_ts ? relTime(listing.created_ts) : 'just now'}</div>
        <div className="mp-row-cell col-act">
          {isMine ? (
            <button className="mp-buy ghost sm" disabled={busy} onClick={onCancel}>
              {busy ? <Loader2 className="spin" size={13} /> : <X size={13} />}
              <span>Cancel</span>
            </button>
          ) : (
            <button className="mp-buy sm" disabled={busy || !account} onClick={onBuy}>
              {busy ? <Loader2 className="spin" size={13} /> : <ShoppingCart size={13} />}
              <span>{!account ? 'Connect' : 'Buy'}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mp-card">
      <div className="mp-card-art mp-card-art-code">
        <InscriptionCodePreview tick={listing.tick} amount={listing.amount} hue={hues.a} />
        <span className="mp-card-proto" title="Protocol">MON-20</span>
        {isMine && <span className="mp-card-mine">YOURS</span>}
      </div>
      <div className="mp-card-body">
        <div className="mp-card-line">
          <span className="mp-card-amount">
            {Number(listing.amount).toLocaleString()}<small> {listing.tick}</small>
          </span>
          <span className="mp-card-id">#{listing.id}</span>
        </div>
        <div className="mp-card-price-row">
          <div className="mp-card-price">
            <span className="lbl">Price</span>
            <strong>{fmtMon(listing.price_mon)} <small>MON</small></strong>
          </div>
          <div className="mp-card-unit">
            <span className="lbl">Unit</span>
            <em>{fmtMon(unit)}</em>
          </div>
        </div>
        <div className="mp-card-onchain">
          {listing.list_tx_hash && (
            <span className="mp-card-tx" title={listing.list_tx_hash}>
              <code>tx</code> <span>{fmtTx(listing.list_tx_hash)}</span>
            </span>
          )}
          <span className="mp-card-insc" title="Inscription id">
            <code>id</code> <span>#{listing.id}</span>
          </span>
        </div>
        <div className="mp-card-meta">
          <span title={listing.seller}>by <code>{fmtAddr(listing.seller)}</code></span>
          <span>{listing.created_ts ? relTime(listing.created_ts) : 'just now'}</span>
        </div>
        {isMine ? (
          <button className="mp-buy ghost" disabled={busy} onClick={onCancel}>
            {busy ? <Loader2 className="spin" size={14} /> : <X size={14} />}
            <span>Cancel listing</span>
          </button>
        ) : (
          <button className="mp-buy" disabled={busy || !account} onClick={onBuy}>
            {busy ? <Loader2 className="spin" size={14} /> : <ShoppingCart size={14} />}
            <span>{!account ? 'Connect to Buy' : `Buy · ${fmtMon(listing.price_mon)} MON`}</span>
            {!busy && account && <ArrowUpRight size={13} className="mp-buy-arrow" />}
          </button>
        )}
      </div>
    </div>
  );
}

function SkeletonCard({ view }) {
  return (
    <div className={`mp-card skeleton ${view === 'list' ? 'list' : ''}`}>
      <div className="mp-card-art skel-shimmer" />
      <div className="mp-card-body">
        <div className="skel-line w70" />
        <div className="skel-line w50" />
        <div className="skel-line w90" />
        <div className="skel-line w70" />
      </div>
    </div>
  );
}

function relTime(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(ts)));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ActivityPanel({ events, loading }) {
  // Aggregate counters per action type for the header strip
  const counts = useMemo(() => {
    const out = { list: 0, sold: 0, cancel: 0 };
    for (const e of events) {
      if (e.kind === 'sold') out.sold++;
      else if (e.kind === 'cancelled') out.cancel++;
      else out.list++;
    }
    return out;
  }, [events]);

  // Sparkline data from sold events (last 24 unit prices)
  const sparkPts = useMemo(() => {
    return [...events]
      .filter(e => e.kind === 'sold')
      .reverse()
      .slice(-24)
      .map(e => Number(e.price_mon) / Math.max(1, Number(e.amount)))
      .filter(n => isFinite(n) && n > 0);
  }, [events]);

  return (
    <div className="mp-act">
      {/* ── Header strip: title + live + counters + sparkline ── */}
      <div className="mp-act-head">
        <div className="mp-act-head-title">
          <span className="mp-act-live"><span className="mp-act-live-dot" /> LIVE</span>
          <h3>Market Activity</h3>
          <span className="mp-act-sub">{events.length.toLocaleString()} events</span>
        </div>
        <div className="mp-act-counters">
          <div className="mp-act-counter sold"><span>Sales</span><strong>{counts.sold.toLocaleString()}</strong></div>
          <div className="mp-act-counter list"><span>Listings</span><strong>{counts.list.toLocaleString()}</strong></div>
          <div className="mp-act-counter cancel"><span>Cancels</span><strong>{counts.cancel.toLocaleString()}</strong></div>
          {sparkPts.length > 1 && (
            <div className="mp-act-spark"><Sparkline points={sparkPts} /></div>
          )}
        </div>
      </div>

      {/* ── Column header (sticky) ── */}
      <div className="mp-act-cols" role="row">
        <span className="mp-act-c-act">Action</span>
        <span className="mp-act-c-tok">Token</span>
        <span className="mp-act-c-amt">Amount</span>
        <span className="mp-act-c-price">Price</span>
        <span className="mp-act-c-unit">Unit</span>
        <span className="mp-act-c-from">From</span>
        <span className="mp-act-c-to">To</span>
        <span className="mp-act-c-tx">Tx</span>
        <span className="mp-act-c-time">Time</span>
      </div>

      {/* ── Rows ── */}
      {loading ? (
        <div className="mp-act-state"><Loader2 className="spin" size={20} /> <span>Loading market activity…</span></div>
      ) : events.length === 0 ? (
        <div className="mp-act-state"><Activity size={22} /> <span>No activity yet.</span></div>
      ) : (
        <div className="mp-act-rows" role="rowgroup">
          {events.map((e, i) => {
            const cls = e.kind === 'sold' ? 'sold' : e.kind === 'cancelled' ? 'cancel' : 'list';
            const label = e.kind === 'sold' ? 'SALE' : e.kind === 'cancelled' ? 'CANCEL' : 'LIST';
            const unit = Number(e.price_mon) / Math.max(1, Number(e.amount));
            const txShort = e.tx_hash ? `${e.tx_hash.slice(0, 6)}…${e.tx_hash.slice(-4)}` : '—';
            return (
              <div
                key={`${e.listing_id}-${e.kind}-${i}`}
                className={`mp-act-row ${cls}`}
                style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                role="row"
              >
                <span className="mp-act-c-act">
                  <span className={`mp-act-pill ${cls}`}>{label}</span>
                </span>
                <span className="mp-act-c-tok"><strong>{e.tick}</strong></span>
                <span className="mp-act-c-amt mono">{Number(e.amount).toLocaleString()}</span>
                <span className="mp-act-c-price mono"><strong>{fmtMon(e.price_mon)}</strong><small> MON</small></span>
                <span className="mp-act-c-unit mono mut">{fmtMon(unit)}</span>
                <span className="mp-act-c-from mono mut" title={e.from}>{fmtAddr(e.from)}</span>
                <span className="mp-act-c-to mono mut" title={e.to || ''}>
                  {e.to ? (<><ArrowRight size={11} className="mp-act-arrow" /> {fmtAddr(e.to)}</>) : '—'}
                </span>
                <span className="mp-act-c-tx mono mut" title={e.tx_hash || ''}>{txShort}</span>
                <span className="mp-act-c-time mut" title={new Date(Number(e.ts) * 1000).toLocaleString()}>{relTime(e.ts)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CreateListingModal({ account, contract, tick, onClose, onCreated, onError }) {
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState(''); // 'tx' | 'mirror'
  const [balance, setBalance] = useState(null);

  useEffect(() => {
    let active = true;
    if (!account) { setBalance(null); return; }
    api.listableBalance(account, tick)
      .then(b => { if (active) setBalance(b); })
      .catch(() => { if (active) setBalance({ owned: 0, locked: 0, available: 0 }); });
    return () => { active = false; };
  }, [account, tick]);

  const unit = Number(amount) > 0 ? Number(price) / Number(amount) : 0;
  const sellerReceives = Number(price) * (1 - FEE_PERCENT / 100);
  const amtNum = Math.floor(Number(amount) || 0);
  const available = balance?.available ?? 0;
  const owned = balance?.owned ?? 0;
  // Only block if the indexer has positively reported a non-zero balance and
  // the user is trying to list more than that. A 0-balance reading is treated
  // as "still syncing" rather than "definitely none" — the on-chain listing
  // call itself is the ultimate source of truth.
  const overBalance = balance && owned > 0 && amtNum > available;
  const valid = account
    && amtNum > 0
    && Number(price) > 0
    && !overBalance;

  const submit = async () => {
    if (!valid) return;
    if (!contract) {
      onError('Marketplace contract not deployed. Deploy contracts/MonadInscriptionMarket.sol and set VITE_MARKET_CONTRACT.');
      return;
    }
    setSubmitting(true);
    try {
      const amt = String(Math.floor(Number(amount)));
      const priceStr = String(price);

      setStep('tx');
      const tickBytes32 = ethers.encodeBytes32String(tick);
      const priceWei = ethers.parseEther(priceStr);
      if (priceWei > (2n ** 96n - 1n)) {
        throw new Error('Price too large for the marketplace contract.');
      }
      const tx = await contract.list(tickBytes32, amt, priceWei);
      const receipt = await tx.wait();
      const listTxHash = tx.hash;

      // Extract the Listed event id from the receipt
      const listedTopic = contract.interface.getEvent('Listed').topicHash;
      const log = receipt.logs.find(l =>
        l.address.toLowerCase() === contract.target.toLowerCase()
        && l.topics[0] === listedTopic
      );
      let onchainId = null;
      if (log) {
        const parsed = contract.interface.parseLog(log);
        onchainId = Number(parsed.args.id);
      }
      if (onchainId == null) throw new Error('Listed event not found in receipt');

      setStep('mirror');
      await api.createListing({
        seller: account,
        tick,
        amount: amt,
        price_mon: priceStr,
        onchain_id: onchainId,
        list_tx_hash: listTxHash,
      });
      onCreated();
    } catch (err) {
      const msg = err?.shortMessage || err?.reason || err?.message || 'List failed';
      onError(msg);
    } finally {
      setSubmitting(false);
      setStep('');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>List {tick} for sale</h3>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        {!account && (
          <div className="modal-warn"><Wallet size={16} /> Connect your wallet to create a listing.</div>
        )}
        {account && balance && owned === 0 && (
          <div className="modal-warn">
            <Wallet size={16} /> Balance still syncing from the indexer. If you just minted, you can still list — the on-chain transaction will succeed once your mint is confirmed.
          </div>
        )}
        {account && balance && owned > 0 && (
          <div className="balance-row">
            <span>Available to list</span>
            <strong>
              {available.toLocaleString()} {tick}
              {balance.locked > 0 && (
                <em> ({owned.toLocaleString()} owned − {balance.locked.toLocaleString()} in active listings)</em>
              )}
            </strong>
          </div>
        )}
        <div className="modal-label-row">
          <label className="modal-label">Amount ({tick})</label>
          {available > 0 && (
            <button type="button" className="modal-max" onClick={() => setAmount(String(available))}>
              MAX
            </button>
          )}
        </div>
        <input
          type="number" min="1" step="1" max={available || undefined} value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={available > 0 ? `up to ${available}` : 'e.g. 1000'}
          className={`modal-input ${overBalance ? 'invalid' : ''}`}
          disabled={!balance || available === 0}
        />
        {overBalance && (
          <div className="modal-err">Amount exceeds your available {tick} balance.</div>
        )}
        <label className="modal-label">Price (MON)</label>
        <input
          type="number" min="0" step="any" value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="e.g. 0.5"
          className="modal-input"
        />
        <div className="modal-summary">
          <span>Unit price</span>
          <span>{unit > 0 ? `${fmtMon(unit)} MON / ${tick}` : '—'}</span>
        </div>
        <div className="modal-summary">
          <span>Protocol fee ({FEE_PERCENT}%)</span>
          <span>{Number(price) > 0 ? `${fmtMon(Number(price) * FEE_PERCENT / 100)} MON` : '—'}</span>
        </div>
        <div className="modal-summary">
          <span>You receive</span>
          <span>{Number(price) > 0 ? `${fmtMon(sellerReceives)} MON` : '—'}</span>
        </div>
        <div className="modal-note">
          {contract
            ? `Listing happens on-chain via the marketplace contract. A 5% fee is automatically deducted from each sale and sent to the protocol treasury. After a buyer pays, you must send a "transfer" inscription to complete delivery — this marketplace is non-custodial.`
            : `Marketplace contract not configured. Listings will be off-chain only.`}
        </div>
        <button
          className="market-btn primary full"
          disabled={!valid || submitting}
          onClick={submit}
        >
          {submitting ? <Loader2 className="spin" size={16} /> : <Tag size={16} />}
          {submitting
            ? (step === 'tx' ? 'Confirm in wallet…' : step === 'mirror' ? 'Indexing…' : 'Creating…')
            : (contract ? 'List on-chain' : 'Create Listing')}
        </button>
      </div>
    </div>
  );
}
