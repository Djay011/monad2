import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ethers } from 'ethers';
import { Wallet, CheckCircle, AlertCircle, LogOut, Zap, Shield, Layers, Globe, Rocket, Target, Search, ExternalLink, Copy, Hash, Clock, TrendingUp, Coins, Sparkles } from 'lucide-react';
import { api, subscribeEvents, rowToActivity } from './api';
import Marketplace from './Marketplace';
import ShaderBackground from './components/ShaderBackground';
import {
  useInjectedWallets, WalletPicker,
  rememberWallet, rememberedWallet, forgetWallet,
  switchOrAddChain,
} from './wallets';

const MONAD_CHAIN_ID = '0x8f'; // 143 in Hex
const TARGET_NETWORK = {
  chainId: MONAD_CHAIN_ID,
  chainName: 'Monad Mainnet',
  nativeCurrency: {
    name: 'MON',
    symbol: 'MON',
    decimals: 18,
  },
  rpcUrls: ['https://rpc.monad.xyz'],
  blockExplorerUrls: ['https://monadvision.com'],
};

// Contract & Mint Details
const RECEIVER_WALLET = '0x6fC09727F83Ef23782cF80Cd11e1bda534532267';
const MINT_PRICE = '0.002'; // 0.002 MON
const INSCRIPTION_DATA = 'data:application/json,{"p":"mon-20","op":"mint","tick":"BOB","amt":"1000"}';
const TOTAL_SUPPLY = 21000000;
const MINT_AMOUNT = 1000;
const TICK = 'BOB';
const INITIAL_MINTED = 0; // Set your starting progress here (e.g. 10M)
// Auto-baselines to the receiver wallet's current balance on first load so supply starts at 0.
const BASELINE_KEY = `bob_baseline_balance_${RECEIVER_WALLET}`;

function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState('');
  const [balance, setBalance] = useState('0.00');
  const [network, setNetwork] = useState(null);
  // Multi-wallet (EIP-6963) state
  const wallets = useInjectedWallets();
  const [walletProvider, setWalletProvider] = useState(null); // raw EIP-1193 provider
  const [pickerOpen, setPickerOpen] = useState(false);

  // Hydrate from localStorage so a page refresh doesn't reset to 0 while the
  // backend indexer is still catching up. The indexer is the source of truth;
  // the cache only prevents a transient "backwards" jump on reload.
  const TOTAL_CACHE_KEY = `mon20_total_minted_${TICK}`;
  const ACTIVITY_CACHE_KEY = `mon20_recent_activity_${TICK}`;
  const readCachedTotal = () => {
    try {
      const v = Number(localStorage.getItem(TOTAL_CACHE_KEY));
      return Number.isFinite(v) && v > 0 ? Math.min(v, TOTAL_SUPPLY) : 0;
    } catch { return 0; }
  };
  const readCachedActivity = () => {
    try {
      const raw = localStorage.getItem(ACTIVITY_CACHE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(0, 200) : [];
    } catch { return []; }
  };
  const [totalMinted, setTotalMinted] = useState(readCachedTotal); // hydrated from cache
  const [recentActivity, setRecentActivity] = useState(readCachedActivity);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [, setNowTick] = useState(0); // forces re-render so relative times update live

  // ── Wallet-specific balance from blockchain (source of truth) ──────────
  // Keyed by wallet address so different wallets see their own data.
  const [userBalance, setUserBalance] = useState(0);
  const [userMintsList, setUserMintsList] = useState([]); // inscriptions the user minted
  const [repeatCount, setRepeatCount] = useState(1);

  const getInitialTab = () => {
    const path = window.location.pathname;
    if (path === '/My-Inscriptions') return 'inscriptions';
    if (path === '/mint') return 'mint';
    if (path === '/marketplace') return 'marketplace';
    if (path === '/docs') return 'docs';
    return 'about'; // Default to about for / or unknown paths
  };
  const [activeTab, setActiveTab] = useState(getInitialTab);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    const pathMap = { inscriptions: '/My-Inscriptions', about: '/', mint: '/mint', marketplace: '/marketplace', docs: '/docs' };
    window.history.pushState(null, '', pathMap[tab] || '/');
  };

  useEffect(() => {
    const handlePopState = () => {
      setActiveTab(getInitialTab());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Re-render every second so relative timestamps stay fresh
  useEffect(() => {
    const id = setInterval(() => setNowTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const [isMinting, setIsMinting] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '' }); // type: 'waiting', 'success', 'error'

  // Load recent on-chain mints from the backend indexer (source of truth)
  const loadRecentFromApi = useCallback(async () => {
    try {
      const data = await api.recentMints(50);
      const items = (data.items || []).map(rowToActivity);
      // Only overwrite the cached list when the backend actually has data,
      // otherwise keep showing the cached items so a refresh isn't blank
      // while the indexer is still warming up.
      if (items.length > 0) {
        setRecentActivity(items);
        try { localStorage.setItem(ACTIVITY_CACHE_KEY, JSON.stringify(items.slice(0, 200))); } catch {}
      }
    } catch (err) {
      console.error('Failed to load recent mints:', err);
    }
  }, [ACTIVITY_CACHE_KEY]);

  // Total minted now comes straight from the indexer DB (real on-chain truth).
  const fetchTotalMinted = useCallback(async () => {
    try {
      const stats = await api.token(TICK);
      let total = INITIAL_MINTED + (Number(stats.total_minted) || 0);
      if (total > TOTAL_SUPPLY) total = TOTAL_SUPPLY;
      return total;
    } catch (err) {
      console.error('Failed to fetch token stats from indexer:', err);
      return null;
    }
  }, []);

  // ── Load wallet balance from the indexer API (blockchain source of truth) ─
  const loadUserBalance = useCallback(async () => {
    if (!account) return;
    try {
      const data = await api.balance(account);
      const entry = (data.balances || []).find(b => b.tick === TICK);
      const bal = entry ? Number(entry.balance) : 0;
      setUserBalance(bal);
      // Cache per-wallet so refresh doesn't flash to 0
      const key = `mon20_balance_${account.toLowerCase()}_${TICK}`;
      try { localStorage.setItem(key, String(bal)); } catch {}
    } catch (err) {
      console.error('Balance fetch failed:', err);
    }
  }, [account]);

  // Persist totalMinted to localStorage whenever it grows so a refresh has
  // an instant, accurate baseline even if the backend hasn't responded yet.
  useEffect(() => {
    if (totalMinted > 0) {
      try { localStorage.setItem(TOTAL_CACHE_KEY, String(totalMinted)); } catch {}
    }
  }, [totalMinted, TOTAL_CACHE_KEY]);

  const checkConnection = useCallback(async (eip1193) => {
    const inj = eip1193 || walletProvider;
    if (!inj) return;
    try {
      const browserProvider = new ethers.BrowserProvider(inj);
      const accounts = await browserProvider.listAccounts();
      if (accounts.length > 0) {
        setProvider(browserProvider);
        const currentSigner = await browserProvider.getSigner();
        setSigner(currentSigner);
        setAccount(accounts[0].address);

        const net = await browserProvider.getNetwork();
        const bal = await browserProvider.getBalance(accounts[0].address);
        setBalance(Number(ethers.formatEther(bal)).toFixed(4));
        setNetwork(net);
      }
    } catch (err) {
      console.error("Failed to check connection", err);
    }
  }, [walletProvider]);

  const handleAccountsChanged = useCallback((accounts) => {
    if (accounts.length === 0) {
      // Disconnected
      setAccount('');
      setSigner(null);
    } else {
      setAccount(accounts[0]);
      checkConnection();
    }
  }, [checkConnection]);

  // User's mints derived from the dedicated user mints list (not global activity).
  const combinedMyInscriptions = useMemo(() => {
    if (!account) return [];
    return userMintsList
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }, [userMintsList, account]);

  // Compute totalMinted from on-chain activity when price is 0 (derived state)
  const localTotalMinted = useMemo(() => {
    if (Number(MINT_PRICE) === 0) {
      const onChainMints = recentActivity.reduce((acc, curr) => acc + curr.amount, 0);
      let newTotal = INITIAL_MINTED + onChainMints;
      if (newTotal > TOTAL_SUPPLY) newTotal = TOTAL_SUPPLY;
      return newTotal;
    }
    return null;
  }, [recentActivity]);

  // Sync localTotalMinted into state when price is 0
  useEffect(() => {
    if (localTotalMinted !== null) {
      const id = requestAnimationFrame(() => setTotalMinted(localTotalMinted));
      return () => cancelAnimationFrame(id);
    }
  }, [localTotalMinted]);

  // Source of truth = backend indexer. Initial load + WS live updates + polling fallback.
  useEffect(() => {
    let isMounted = true;
    setIsLoadingHistory(true);

    // On initial load, never ratchet the bar BACKWARDS below the cached
    // value — the indexer may briefly return 0 right after a backend restart.
    fetchTotalMinted().then((result) => {
      if (isMounted && result !== null) setTotalMinted(prev => Math.max(prev, result));
    });

    loadRecentFromApi().finally(() => {
      if (isMounted) setIsLoadingHistory(false);
    });

    const refreshAll = () => {
      loadRecentFromApi();
      // Use Math.max so the 15s poll never ratchets the bar back down past
      // an optimistic local bump made after a fresh mint.
      fetchTotalMinted().then(t => {
        if (isMounted && t !== null) setTotalMinted(prev => Math.max(prev, t));
      });
    };

    // Polling fallback (in case WS drops)
    const pollTimer = setInterval(refreshAll, 15000);

    // Also poll wallet balance every 15s to stay in sync
    const balancePollTimer = setInterval(() => {
      if (isMounted) loadUserBalance();
    }, 15000);

    // WebSocket live feed: handles mints, marketplace events, and balance changes
    const unsubscribe = subscribeEvents({
      onMints: (items) => {
        if (!isMounted || !items.length) return;
        const mapped = items.map(rowToActivity);
        setRecentActivity(prev => {
          const seen = new Set(prev.map(e => e.hash));
          const merged = [...mapped.filter(e => !seen.has(e.hash)), ...prev];
          merged.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          return merged.slice(0, 200);
        });
        fetchTotalMinted().then(t => {
          if (isMounted && t !== null) setTotalMinted(prev => Math.max(prev, t));
        });
        // If any new mints belong to the connected wallet, refresh balance
        if (account) {
          const lower = account.toLowerCase();
          if (mapped.some(e => e.from === lower)) {
            loadUserBalance();
          }
        }
      },
      onBalanceUpdate: (data) => {
        if (!isMounted || !account) return;
        const lower = account.toLowerCase();
        if (data.seller === lower || data.buyer === lower) {
          // Marketplace sale affected this wallet — refresh balance
          loadUserBalance();
        }
      },
      onMarketEvent: (_data) => {
        // Could trigger marketplace refresh — handled by Marketplace component
      },
    });

    const handleChainChanged = () => window.location.reload();
    const inj = walletProvider;
    if (inj && typeof inj.on === 'function') {
      inj.on('accountsChanged', handleAccountsChanged);
      inj.on('chainChanged', handleChainChanged);
      queueMicrotask(() => checkConnection(inj));
    }

    return () => {
      isMounted = false;
      clearInterval(pollTimer);
      clearInterval(balancePollTimer);
      unsubscribe();
      if (inj && typeof inj.removeListener === 'function') {
        inj.removeListener('accountsChanged', handleAccountsChanged);
        inj.removeListener('chainChanged', handleChainChanged);
      }
    };
  }, [fetchTotalMinted, handleAccountsChanged, checkConnection, loadRecentFromApi, walletProvider, loadUserBalance, account]);

  // When wallet connects, load the full portfolio (balance + mint history).
  useEffect(() => {
    if (!account) {
      setUserBalance(0);
      setUserMintsList([]);
      return;
    }
    let cancelled = false;
    setIsLoadingHistory(true);

    // Hydrate balance from per-wallet cache immediately (prevents 0-flash)
    const cacheKey = `mon20_balance_${account.toLowerCase()}_${TICK}`;
    try {
      const cached = Number(localStorage.getItem(cacheKey));
      if (Number.isFinite(cached) && cached > 0) setUserBalance(cached);
    } catch {}

    // Fetch full portfolio from API
    api.walletPortfolio(account)
      .then((data) => {
        if (cancelled) return;
        // Update balance from blockchain
        const entry = (data.balances || []).find(b => b.tick === TICK);
        const bal = entry ? Number(entry.balance) : 0;
        setUserBalance(bal);
        try { localStorage.setItem(cacheKey, String(bal)); } catch {}

        // Update user's mint history
        const mapped = (data.mints || []).map(rowToActivity);
        setUserMintsList(mapped);

        // Also merge into global activity feed
        setRecentActivity(prev => {
          const seen = new Set(prev.map(e => e.hash));
          const merged = [...prev, ...mapped.filter(e => !seen.has(e.hash))];
          merged.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          return merged.slice(0, 500);
        });
      })
      .catch((err) => console.error('Load wallet portfolio failed:', err))
      .finally(() => { if (!cancelled) setIsLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [account]);

  // Connect using a specific injected EIP-1193 provider (chosen via picker).
  const connectWith = useCallback(async (walletInfo) => {
    const inj = walletInfo?.provider;
    if (!inj) {
      setStatus({ type: 'error', message: 'No wallet selected.' });
      return;
    }
    try {
      setStatus({ type: '', message: '' });
      const browserProvider = new ethers.BrowserProvider(inj);
      await browserProvider.send('eth_requestAccounts', []);

      const currentSigner = await browserProvider.getSigner();
      const address = await currentSigner.getAddress();
      const net = await browserProvider.getNetwork();
      const bal = await browserProvider.getBalance(address);

      setWalletProvider(inj);
      setProvider(browserProvider);
      setSigner(currentSigner);
      setAccount(address);
      setBalance(Number(ethers.formatEther(bal)).toFixed(4));
      setNetwork(net);
      rememberWallet(walletInfo.rdns);

      await checkAndSwitchNetwork(browserProvider, inj);
    } catch (err) {
      console.error('[connectWith] failed:', err);
      let msg = 'Failed to connect wallet.';
      if (err?.code === 4001 || err?.code === 'ACTION_REJECTED') msg = 'Connection rejected.';
      else if (err?.code === -32002) msg = 'Connection request already pending — open your wallet.';
      else if (err?.message) msg = `Connect failed: ${err.message.slice(0, 120)}`;
      setStatus({ type: 'error', message: msg });
    }
  }, []);

  // Open the picker. If only one wallet is installed, connect directly.
  const connectWallet = useCallback(async () => {
    if (wallets.length === 0) {
      setStatus({ type: 'error', message: 'No EVM wallet detected. Install MetaMask, Rabby, Phantom, etc.' });
      return;
    }
    if (wallets.length === 1) {
      await connectWith(wallets[0]);
      return;
    }
    setPickerOpen(true);
  }, [wallets, connectWith]);

  // Auto-reconnect on mount if a wallet was previously chosen.
  useEffect(() => {
    const rdns = rememberedWallet();
    if (!rdns || walletProvider) return;
    const w = wallets.find(x => x.rdns === rdns);
    if (!w) return;
    // Silent: just re-bind the provider; checkConnection will pull existing accounts.
    setWalletProvider(w.provider);
  }, [wallets, walletProvider]);

  const disconnectWallet = () => {
    setAccount('');
    setSigner(null);
    setProvider(null);
    setWalletProvider(null);
    setBalance('0.00');
    setNetwork(null);
    forgetWallet();
    setStatus({ type: '', message: 'Wallet disconnected' });
    setTimeout(() => setStatus({ type: '', message: '' }), 3000);
  };

  const checkAndSwitchNetwork = async (prov, eip1193) => {
    const inj = eip1193 || walletProvider;
    if (!inj) return;
    const net = await prov.getNetwork();
    const currentChainId = '0x' + net.chainId.toString(16);

    if (currentChainId.toLowerCase() !== MONAD_CHAIN_ID.toLowerCase()) {
      try {
        await switchOrAddChain(inj, MONAD_CHAIN_ID, TARGET_NETWORK);
      } catch (err) {
        const msg = err?.code === 4902
          ? 'Failed to add Monad network.'
          : 'Failed to switch to Monad network.';
        setStatus({ type: 'error', message: msg });
      }
    }
  };

  const mintPepo = async () => {
    if (!signer) {
      connectWallet();
      return;
    }

    if (totalMinted >= TOTAL_SUPPLY) {
      setStatus({ type: 'error', message: 'Sold Out!' });
      return;
    }

    const totalAmountToMint = MINT_AMOUNT * repeatCount;
    if (totalMinted + totalAmountToMint > TOTAL_SUPPLY) {
      const maxAllowed = Math.floor((TOTAL_SUPPLY - totalMinted) / MINT_AMOUNT);
      setStatus({ type: 'error', message: `Exceeds limit! Only ${maxAllowed} repeats left.` });
      return;
    }

    // Ensure we are on the right network before minting
    const net = await provider.getNetwork();
    const currentChainId = '0x' + net.chainId.toString(16);
    if (currentChainId.toLowerCase() !== MONAD_CHAIN_ID.toLowerCase()) {
      setStatus({ type: 'waiting', message: 'Please switch to Monad network and try again.' });
      await checkAndSwitchNetwork(provider);
      return;
    }

    setIsMinting(true);

    try {
      setStatus({ type: 'waiting', message: 'Waiting for confirmation...' });

      // Calculate total amount and price based on repeat count
      const singlePrice = ethers.parseEther(MINT_PRICE);
      const totalValue = singlePrice * BigInt(repeatCount);

      // Generate custom inscription data for the batch
      const customDataString = `data:application/json,{"p":"mon-20","op":"mint","tick":"${TICK}","amt":"${totalAmountToMint}"}`;
      const hexData = ethers.hexlify(ethers.toUtf8Bytes(customDataString));

      // Explicitly fetch nonce — some Monad RPCs return malformed responses
      // when ethers v6 auto-populates, causing 'invalid value for value.nonce'.
      const nonce = await provider.getTransactionCount(account, 'pending');

      const txRequest = {
        to: RECEIVER_WALLET,
        value: totalValue,
        data: hexData,
        nonce,
      };

      // Send the single transaction
      const tx = await signer.sendTransaction(txRequest);

      setStatus({ type: 'waiting', message: `Transaction submitted! Waiting for block...` });

      // Wait for confirmation
      await tx.wait();

      // Optimistically grow the progress bar IMMEDIATELY — the indexer
      // typically lags by one poll cycle, so we don't want to wait for it.
      setTotalMinted(prev => Math.min(TOTAL_SUPPLY, prev + totalAmountToMint));

      // Optimistically bump the wallet balance
      setUserBalance(prev => prev + totalAmountToMint);

      // Optimistic activity insert; the backend WebSocket will replace this
      // entry (matched by tx hash) once the indexer picks it up.
      const optimisticEntry = {
        hash: tx.hash,
        amount: totalAmountToMint,
        from: account.toLowerCase(),
        block: 0,
        time: new Date().toLocaleString(),
        timestamp: Math.floor(Date.now() / 1000),
        tick: TICK,
      };
      setRecentActivity(prev => [optimisticEntry, ...prev]);
      setUserMintsList(prev => [optimisticEntry, ...prev]);

      // Converge to on-chain truth: poll the indexer for up to ~30s, but only
      // accept a value that is >= our optimistic count so the bar never jumps
      // backwards if the indexer is still catching up.
      (async () => {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const t = await fetchTotalMinted();
          if (t == null) continue;
          let stop = false;
          setTotalMinted(prev => {
            if (t >= prev) { stop = (t === prev); return t; }
            return prev; // indexer still behind; keep optimistic value
          });
          loadRecentFromApi();
          loadUserBalance(); // converge wallet balance with blockchain
          if (stop) break;
        }
      })();

      setStatus({ type: 'success', message: `Success! ${totalAmountToMint.toLocaleString()} ${TICK} Minted` });

    } catch (err) {
      console.error('Mint error:', err);
      let errMsg = 'Transaction Failed';
      if (err.code === 'ACTION_REJECTED' || err.info?.error?.code === 4001) {
        errMsg = 'Transaction rejected by user.';
      } else if (err.code === 'INSUFFICIENT_FUNDS') {
        errMsg = 'Insufficient MON balance for this mint.';
      } else if (err.code === 'NETWORK_ERROR') {
        errMsg = 'Network error. Check your connection / RPC.';
      } else if (err.info?.error?.message) {
        errMsg = err.info.error.message;
      } else if (err.shortMessage) {
        errMsg = err.shortMessage;
      } else if (err.reason) {
        errMsg = err.reason;
      } else if (err.message) {
        errMsg = err.message.length > 140 ? err.message.slice(0, 140) + '…' : err.message;
      }
      setStatus({ type: 'error', message: `Error: ${errMsg}` });
    }

    setIsMinting(false);
  };

  const formatAddress = (addr) => {
    return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
  };

  const formatRelativeTime = (timestamp) => {
    if (!timestamp) return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  return (
    <div className="app-container">
      {activeTab === 'about' && <ShaderBackground />}
      <header>
        <div className="logo" onClick={() => handleTabChange('about')}>
          <img src="/logo.png" alt="Monad Logo" className="logo-img" />
          Monad Inscriptions
        </div>

        <nav className="header-nav">
          <a
            href="/mint"
            className={`nav-link ${activeTab === 'mint' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); handleTabChange('mint'); }}
          >Mint</a>
          <a
            href="/My-Inscriptions"
            className={`nav-link ${activeTab === 'inscriptions' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); handleTabChange('inscriptions'); }}
          >My Inscriptions</a>
          <span className="nav-link disabled">Deploy <span className="soon-badge">soon</span></span>
          <a
            href="/marketplace"
            className={`nav-link ${activeTab === 'marketplace' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); handleTabChange('marketplace'); }}
          >Marketplace</a>
        </nav>

        <div className="header-right">
          <a href="https://x.com/MonadInscribe" target="_blank" rel="noopener noreferrer" className="x-link">
            <svg viewBox="0 0 1200 1227" fill="currentColor" width="18" height="18">
              <path d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z" />
            </svg>
          </a>
          {account ? (
            <div className="wallet-info-container">
              <div className="wallet-balance">
                {balance} MON
              </div>
              <div className="wallet-address" onClick={disconnectWallet} title="Disconnect Wallet">
                {formatAddress(account)}
                {network && network.chainId !== 143n && ' (Wrong Net)'}
                <LogOut size={16} style={{ marginLeft: '8px', opacity: 0.7 }} />
              </div>
            </div>
          ) : (
            <button
              className="wallet-btn"
              onClick={connectWallet}
            >
              <Wallet size={18} />
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      <main>
        {activeTab === 'mint' && (
          <div className="mint-layout">
          <div className="mint-card-new">
            <div className="mint-card-top">
              <span className="minting-label">MINTING</span>
              <span className="minting-ticker">${TICK}</span>
            </div>

            <div className="progress-text-row">
              <span className="progress-percentage">{totalMinted > 0 ? ((totalMinted / TOTAL_SUPPLY) * 100).toFixed(4) : 0}%</span>
              <span className="progress-numbers">{totalMinted.toLocaleString()} / {TOTAL_SUPPLY.toLocaleString()} {TICK}</span>
            </div>
            <div className="card-progress-container">
              <div
                className="card-progress-fill"
                style={{ width: totalMinted > 0 ? `${Math.max(2, (totalMinted / TOTAL_SUPPLY) * 100)}%` : '0%' }}
              ></div>
            </div>

            <div className="input-row">
              <div className="input-field-group">
                <label>AMOUNT PER MINT</label>
                <input type="text" value={MINT_AMOUNT.toLocaleString()} readOnly />
              </div>
              <div className="input-field-group">
                <label>REPEAT (1 – 5000)</label>
                <input
                  type="number"
                  min="1"
                  max="5000"
                  value={repeatCount}
                  onChange={(e) => {
                    let val = parseInt(e.target.value);
                    if (isNaN(val)) val = 1;
                    if (val > 5000) val = 5000;
                    if (val < 1) val = 1;
                    setRepeatCount(val);
                  }}
                />
              </div>
            </div>

            <p className="remaining-info">
              {(TOTAL_SUPPLY - totalMinted).toLocaleString()} remaining · limit {MINT_AMOUNT.toLocaleString()}
            </p>

            <div className="calldata-preview">
              <label>CALLDATA PREVIEW</label>
              <pre>
                {`{
  "p": "mon-20",
  "op": "mint",
  "tick": "${TICK}",
  "amt": "${repeatCount * MINT_AMOUNT}"
}`}
              </pre>
            </div>

            <div className="fee-summary-box">
              <div className="fee-row">
                <span>Total Tokens</span>
                <span>{repeatCount} × {MINT_AMOUNT.toLocaleString()} = {(repeatCount * MINT_AMOUNT).toLocaleString()} {TICK}</span>
              </div>
              <div className="fee-row">
                <span>Protocol Fee</span>
                <span>{Number(MINT_PRICE) === 0 ? 'Free' : `${MINT_PRICE} MON`}</span>
              </div>
              <div className="fee-row">
                <span>Network Fee (est.)</span>
                <span>~0.0001 MON</span>
              </div>
              <div className="fee-row total-row">
                <span>Total Fee</span>
                <span>{Number(MINT_PRICE) === 0 ? 'Free' : `${parseFloat((repeatCount * Number(MINT_PRICE)).toFixed(6))} MON`}</span>
              </div>

              <button
                className={`mint-btn-new ${totalMinted >= TOTAL_SUPPLY ? 'sold-out' : ''}`}
                onClick={!account ? connectWallet : mintPepo}
                disabled={isMinting || totalMinted >= TOTAL_SUPPLY}
              >
                {totalMinted >= TOTAL_SUPPLY
                  ? 'Sold Out'
                  : (!account ? 'Connect Wallet' : (isMinting ? `Minting...` : 'Mint'))}
              </button>
            </div>

            {status.message && (
              <div className={`status-box status-${status.type}`}>
                <span style={{ verticalAlign: 'middle' }}>{status.message}</span>
              </div>
            )}
          </div>

          <aside className="activity-sidebar">
            <div className="activity-sidebar-header">
              <div className="activity-title-wrap">
                <span className="activity-live-dot" />
                <span className="activity-title">Live Mint Activity</span>
              </div>
              <span className="activity-count">
                {recentActivity.length > 0 ? `${recentActivity.length} on-chain` : 'Scanning…'}
              </span>
            </div>
            <div className="activity-feed">
              {recentActivity.length === 0 ? (
                <div className="activity-empty">
                  <div className="activity-empty-pulse" />
                  <p>Waiting for new mints on-chain…</p>
                  <span>Scanning Monad blocks every 15s</span>
                </div>
              ) : (
                recentActivity.slice(0, 20).map((inc) => (
                  <a
                    key={inc.hash}
                    href={`https://monadvision.com/tx/${inc.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="activity-row"
                  >
                    <div className="activity-row-top">
                      <span className="activity-amount">+{inc.amount.toLocaleString()} {TICK}</span>
                      <span className="activity-time" title={inc.time}>{formatRelativeTime(inc.timestamp)}</span>
                    </div>
                    <div className="activity-row-bottom">
                      <span className="activity-from" title={inc.from}>
                        by {formatAddress(inc.from)}
                      </span>
                      <span className="activity-hash">{formatAddress(inc.hash)}</span>
                    </div>
                  </a>
                ))
              )}
            </div>
          </aside>
          </div>
        )}

        {activeTab === 'inscriptions' && (
          <MyInscriptions
            account={account}
            inscriptions={combinedMyInscriptions}
            isLoading={isLoadingHistory}
            tick={TICK}
            totalSupply={TOTAL_SUPPLY}
            walletBalance={userBalance}
            onConnect={connectWallet}
            onGoMint={() => handleTabChange('mint')}
            onGoMarket={() => handleTabChange('marketplace')}
          />
        )}

        {activeTab === 'marketplace' && (
          <Marketplace account={account} signer={signer} tick={TICK} onBalanceChange={loadUserBalance} />
        )}

        {activeTab === 'about' && (
          <div className="about-page">
            <div className="about-hero">
              <div className="about-hero-glow"></div>
              <img src="/logo.png" alt="Monad Inscriptions" className="about-logo" />
              <h1 className="about-title">Monad Inscriptions</h1>
              <p className="about-subtitle">
                The first MON-20 inscription protocol built on the Monad blockchain.
                Mint, deploy, and trade on-chain digital assets at lightning speed.
              </p>
              <button className="about-cta" onClick={() => handleTabChange('mint')}>
                <Rocket size={18} />
                Start Minting
              </button>
            </div>

            <div className="about-section">
              <h2 className="about-section-title">
                <Target size={22} />
                What are MON-20 Inscriptions?
              </h2>
              <p className="about-text">
                MON-20 is an experimental inscription standard on the Monad blockchain, inspired by BRC-20 
                on Bitcoin. It allows users to deploy, mint, and transfer fungible tokens by inscribing 
                JSON data directly onto transactions. Each inscription is immutable and permanently recorded 
                on-chain, creating a transparent and verifiable record of every token operation.
              </p>
              
              <div className="inscription-visual">
                <div className="visual-header">
                  <span className="visual-title">· INSCRIPTION · MON-20 · IMMUTABLE</span>
                </div>
                <div className="visual-body">
                  <div className="line-numbers">
                    <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span>
                  </div>
                  <pre className="code-content">
                    <code>
                      {"{\n"}
                      {"  \"p\": \""} <span className="syntax-string">mon-20</span> {"\",\n"}
                      {"  \"op\": \""} <span className="syntax-string">mint</span> {"\",\n"}
                      {"  \"tick\": \""} <span className="syntax-string">MON</span> {"\",\n"}
                      {"  \"amt\": \""} <span className="syntax-string">1000</span> {"\"\n"}
                      {"}"}
                    </code>
                  </pre>
                </div>
                <div className="visual-footer">
                  <span className="status-dot"></span>
                  <span className="status-text">SEALED · MON</span>
                </div>
              </div>
            </div>

            <div className="about-features-grid">
              <div className="about-feature-card">
                <div className="feature-icon-wrap">
                  <Zap size={24} />
                </div>
                <h3>Parallel Execution</h3>
                <p>
                  Unlike traditional EVM chains that process transactions sequentially, Monad uses 
                  optimistic parallel execution — identifying non-conflicting transactions and processing 
                  them simultaneously for massive throughput gains.
                </p>
              </div>
              <div className="about-feature-card">
                <div className="feature-icon-wrap">
                  <Shield size={24} />
                </div>
                <h3>MonadBFT Consensus</h3>
                <p>
                  A custom-built, pipelined Byzantine Fault Tolerant consensus mechanism that achieves 
                  sub-second block times and near-instant finality, making it ideal for high-frequency 
                  applications.
                </p>
              </div>
              <div className="about-feature-card">
                <div className="feature-icon-wrap">
                  <Layers size={24} />
                </div>
                <h3>MonadDB</h3>
                <p>
                  A specialized, high-performance database layer designed specifically for the I/O demands 
                  of parallel transaction processing and efficient state management on-chain.
                </p>
              </div>
              <div className="about-feature-card">
                <div className="feature-icon-wrap">
                  <Globe size={24} />
                </div>
                <h3>Full EVM Compatibility</h3>
                <p>
                  Monad is byte-for-byte compatible with the Ethereum Virtual Machine. Existing smart contracts, 
                  wallets, and developer tooling work seamlessly without any modifications.
                </p>
              </div>
            </div>

            <div className="about-section">
              <h2 className="about-section-title">
                <Globe size={22} />
                What is Monad?
              </h2>
              <p className="about-text">
                Monad is a high-performance Layer-1 blockchain that is fully compatible with the 
                Ethereum Virtual Machine (EVM). Launched in November 2025, Monad addresses the scalability 
                and performance limitations found in existing EVM-compatible chains by enabling significantly 
                higher throughput and lower latency — all while maintaining the security and decentralization 
                of a Layer-1 network.
              </p>
            </div>

            <div className="about-section">
              <h2 className="about-section-title">
                <Rocket size={22} />
                Our Mission
              </h2>
              <p className="about-text">
                Monad Inscriptions aims to be the go-to platform for the MON-20 ecosystem. Our goals include:
              </p>
              <div className="about-goals-list">
                <div className="about-goal-item">
                  <span className="goal-number">01</span>
                  <div>
                    <h4>Fair & Transparent Minting</h4>
                    <p>Provide a clean, user-friendly interface for minting MON-20 tokens with real-time supply tracking and on-chain verification.</p>
                  </div>
                </div>
                <div className="about-goal-item">
                  <span className="goal-number">02</span>
                  <div>
                    <h4>Token Deployment</h4>
                    <p>Enable anyone to deploy their own MON-20 tokens with customizable parameters — coming soon to the platform.</p>
                  </div>
                </div>
                <div className="about-goal-item">
                  <span className="goal-number">03</span>
                  <div>
                    <h4>Decentralized Marketplace</h4>
                    <p>Build a peer-to-peer marketplace for trading MON-20 inscriptions, bringing liquidity and price discovery to the ecosystem.</p>
                  </div>
                </div>
                <div className="about-goal-item">
                  <span className="goal-number">04</span>
                  <div>
                    <h4>Community Driven</h4>
                    <p>Foster a vibrant community of creators and collectors on Monad, empowering users to shape the future of on-chain inscriptions.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="about-stats-bar">
              <div className="about-stat">
                <span className="about-stat-value">10,000+</span>
                <span className="about-stat-label">TPS Capacity</span>
              </div>
              <div className="about-stat">
                <span className="about-stat-value">&lt;1s</span>
                <span className="about-stat-label">Block Time</span>
              </div>
              <div className="about-stat">
                <span className="about-stat-value">100%</span>
                <span className="about-stat-label">EVM Compatible</span>
              </div>
              <div className="about-stat">
                <span className="about-stat-value">$MON</span>
                <span className="about-stat-label">Native Token</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'docs' && (
          <div className="docs-page">
            <div className="docs-hero">
              <span className="docs-eyebrow">DOCUMENTATION</span>
              <h1>How Monad Inscriptions Works</h1>
              <p>A protocol-focused guide to minting, holding, and trading <code>mon-20</code> inscriptions on the Monad blockchain.</p>
            </div>

            <section className="docs-section">
              <h2>1. What is a mon-20 inscription?</h2>
              <p>
                <code>mon-20</code> is a lightweight, JSON-based token standard for Monad — inspired by Bitcoin Ordinals BRC-20.
                Each inscription is a plain JSON payload embedded directly in the transaction <code>calldata</code> sent to a
                receiver wallet. There is no smart contract for the token itself; the chain is the database, and indexers reconstruct supply, balances, and history by reading transactions.
              </p>
              <pre className="docs-code">
{`{
  "p":    "mon-20",
  "op":   "mint",
  "tick": "BOB",
  "amt":  "1000"
}`}
              </pre>
            </section>

            <section className="docs-section">
              <h2>2. Minting</h2>
              <p>When you click <strong>Mint</strong>:</p>
              <ol>
                <li>Your wallet signs a transaction sending <strong>0.002 MON</strong> (protocol fee) to the receiver wallet.</li>
                <li>The <code>calldata</code> field carries the JSON inscription payload above.</li>
                <li>Once mined, our backend indexer parses the tx, validates the JSON, and credits your address with the minted amount.</li>
                <li>The progress bar and live activity feed update in real-time over WebSocket.</li>
              </ol>
              <p className="docs-note">
                <strong>Note:</strong> there is no smart contract minting — ownership is established purely by the chain transcript. Refreshing your browser will not lose data because all state lives on Monad.
              </p>
            </section>

            <section className="docs-section">
              <h2>3. My Inscriptions</h2>
              <p>
                The <strong>My Inscriptions</strong> page queries the indexer for every mint <em>and</em> transfer that affected your address, then aggregates them into a single balance.
                Every row is a verifiable on-chain transaction — click any tx hash to inspect it in a Monad block explorer.
              </p>
            </section>

            <section className="docs-section">
              <h2>4. Marketplace</h2>
              <p>The marketplace is fully non-custodial:</p>
              <ul>
                <li><strong>Listing:</strong> tokens are escrowed in the marketplace contract (<code>MonadInscriptionMarket.sol</code>) via a <code>list()</code> call. They remain yours until sold.</li>
                <li><strong>Buying:</strong> the buyer sends MON to the contract, which atomically transfers the inscription amount to them and forwards the funds (minus protocol fee) to the seller.</li>
                <li><strong>Cancelling:</strong> sellers can withdraw their tokens any time with <code>cancel()</code>.</li>
              </ul>
              <p>A small protocol fee is taken on each sale. All listings and sales are indexed from on-chain events — no off-chain database trust required.</p>
            </section>

            <section className="docs-section">
              <h2>5. Architecture</h2>
              <ul>
                <li><strong>Frontend:</strong> React + Vite, deployed on Vercel.</li>
                <li><strong>Indexer:</strong> Node.js + SQLite, polls Monad RPC every 4 s, parses inscriptions, broadcasts new events over WebSocket.</li>
                <li><strong>Marketplace contract:</strong> Solidity contract on Monad — events (<code>Listed</code>, <code>Sold</code>, <code>Cancelled</code>) are indexed and surfaced in the UI in real time.</li>
                <li><strong>Wallet:</strong> EIP-6963 multi-wallet detection. MetaMask, Rabby, OKX, Phantom etc. all work out of the box.</li>
              </ul>
            </section>

            <section className="docs-section">
              <h2>6. Network details</h2>
              <table className="docs-table">
                <tbody>
                  <tr><th>Network</th><td>Monad</td></tr>
                  <tr><th>Chain ID</th><td>143</td></tr>
                  <tr><th>RPC URL</th><td><code>https://rpc.monad.xyz</code></td></tr>
                  <tr><th>Native token</th><td>MON</td></tr>
                  <tr><th>Protocol</th><td><code>mon-20</code></td></tr>
                </tbody>
              </table>
            </section>

            <section className="docs-section">
              <h2>7. FAQ</h2>
              <details className="docs-faq">
                <summary>Do I need MON to mint?</summary>
                <p>Yes — 0.002 MON per mint as the protocol fee, plus a small gas cost (typically &lt; 0.0001 MON).</p>
              </details>
              <details className="docs-faq">
                <summary>Can I lose my inscriptions if the site goes down?</summary>
                <p>No. Inscriptions live on Monad. The website is just a viewer / trading interface. Anyone can run their own indexer against the same data.</p>
              </details>
              <details className="docs-faq">
                <summary>Why does it sometimes take a few seconds to show my mint?</summary>
                <p>The indexer polls Monad every 4 seconds. Your transaction is final the moment it's mined; the UI just needs one polling cycle to reflect it.</p>
              </details>
              <details className="docs-faq">
                <summary>Is this open source?</summary>
                <p>Yes — the full codebase (frontend, indexer, contracts) is on GitHub.</p>
              </details>
            </section>
          </div>
        )}
      </main>

      <footer className="site-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <img src="/logo.png" alt="Monad Inscriptions" className="footer-logo" />
            <div>
              <strong>Monad Inscriptions</strong>
              <span>Built for the Monad Ecosystem</span>
            </div>
          </div>
          <nav className="footer-nav">
            <a href="/mint" onClick={(e) => { e.preventDefault(); handleTabChange('mint'); }}>Mint</a>
            <a href="/marketplace" onClick={(e) => { e.preventDefault(); handleTabChange('marketplace'); }}>Marketplace</a>
            <a href="/My-Inscriptions" onClick={(e) => { e.preventDefault(); handleTabChange('inscriptions'); }}>My Inscriptions</a>
            <a href="/docs" onClick={(e) => { e.preventDefault(); handleTabChange('docs'); }}>Docs</a>
          </nav>
          <div className="footer-social">
            <a href="https://x.com/MonadInscribe" target="_blank" rel="noopener noreferrer" aria-label="X / Twitter" className="footer-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
            </a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Monad Inscriptions · mon-20 protocol</span>
          <span>Settled on Monad · Non-custodial</span>
        </div>
      </footer>

      <WalletPicker
        open={pickerOpen}
        wallets={wallets}
        onPick={async (w) => { setPickerOpen(false); await connectWith(w); }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

const fmtAddrShort = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const relTime = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(ts)));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

function MyInscriptions({ account, inscriptions, isLoading, tick, totalSupply, walletBalance, onConnect, onGoMint, onGoMarket }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest'); // newest | oldest | largest
  const [copied, setCopied] = useState('');

  // Use the API-sourced wallet balance (blockchain truth) instead of deriving
  // from the activity feed, which was the root cause of disappearing balances.
  const totalBalance = walletBalance != null ? walletBalance : inscriptions.reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const mintsCount = inscriptions.length;
  const supplyShare = totalSupply > 0 ? (totalBalance / totalSupply) * 100 : 0;
  const firstMint = useMemo(() => inscriptions.reduce((min, c) => (!min || (c.timestamp ?? Infinity) < (min.timestamp ?? Infinity)) ? c : min, null), [inscriptions]);
  const lastMint = useMemo(() => inscriptions.reduce((max, c) => (!max || (c.timestamp ?? 0) > (max.timestamp ?? 0)) ? c : max, null), [inscriptions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = inscriptions;
    if (q) arr = arr.filter(i => i.hash.toLowerCase().includes(q) || String(i.amount).includes(q));
    arr = [...arr];
    if (sort === 'oldest') arr.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    else if (sort === 'largest') arr.sort((a, b) => b.amount - a.amount);
    else arr.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return arr;
  }, [inscriptions, query, sort]);

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 1200); } catch {}
  };

  if (!account) {
    return (
      <div className="inscriptions-section">
        <div className="myinsc-empty">
          <div className="myinsc-empty-glow" />
          <Wallet size={42} />
          <h3>Connect your wallet</h3>
          <p>Sign in to view your on-chain <strong>{tick}</strong> inscriptions and minting history.</p>
          <button className="wallet-btn" onClick={onConnect}><Wallet size={16} /> Connect Wallet</button>
        </div>
      </div>
    );
  }

  return (
    <div className="inscriptions-section">
      {/* Hero card */}
      <div className="myinsc-hero">
        <div className="myinsc-hero-bg" />
        <div className="myinsc-hero-left">
          <div className="myinsc-eyebrow"><Sparkles size={14} /> On-chain holdings</div>
          <div className="myinsc-balance">
            <span className="myinsc-balance-value">{totalBalance.toLocaleString()}</span>
            <span className="myinsc-balance-tick">${tick}</span>
          </div>
          <div className="myinsc-address" title={account} onClick={() => copy(account)}>
            <Hash size={13} /> {fmtAddrShort(account)}
            {copied === account ? <CheckCircle size={13} /> : <Copy size={13} />}
          </div>
        </div>
        <div className="myinsc-hero-right">
          <button className="myinsc-cta primary" onClick={onGoMarket}>
            <TrendingUp size={16} /> List on Marketplace
          </button>
          <button className="myinsc-cta ghost" onClick={onGoMint}>
            <Zap size={16} /> Mint more
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="myinsc-stats">
        <div className="myinsc-stat">
          <div className="myinsc-stat-icon"><Coins size={16} /></div>
          <div>
            <div className="myinsc-stat-label">Total Balance</div>
            <div className="myinsc-stat-value">{totalBalance.toLocaleString()} {tick}</div>
          </div>
        </div>
        <div className="myinsc-stat">
          <div className="myinsc-stat-icon"><Layers size={16} /></div>
          <div>
            <div className="myinsc-stat-label">Inscriptions</div>
            <div className="myinsc-stat-value">{mintsCount.toLocaleString()}</div>
          </div>
        </div>
        <div className="myinsc-stat">
          <div className="myinsc-stat-icon"><TrendingUp size={16} /></div>
          <div>
            <div className="myinsc-stat-label">Share of Supply</div>
            <div className="myinsc-stat-value">{supplyShare < 0.0001 ? '<0.0001' : supplyShare.toFixed(4)}%</div>
          </div>
        </div>
        <div className="myinsc-stat">
          <div className="myinsc-stat-icon"><Clock size={16} /></div>
          <div>
            <div className="myinsc-stat-label">Last mint</div>
            <div className="myinsc-stat-value">{lastMint ? relTime(lastMint.timestamp) : '—'}</div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="myinsc-toolbar">
        <div className="myinsc-search">
          <Search size={15} />
          <input
            type="text"
            placeholder="Search by tx hash or amount…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="myinsc-sort">
          <button className={`myinsc-sort-btn ${sort === 'newest' ? 'active' : ''}`} onClick={() => setSort('newest')}>Newest</button>
          <button className={`myinsc-sort-btn ${sort === 'oldest' ? 'active' : ''}`} onClick={() => setSort('oldest')}>Oldest</button>
          <button className={`myinsc-sort-btn ${sort === 'largest' ? 'active' : ''}`} onClick={() => setSort('largest')}>Largest</button>
        </div>
      </div>

      {/* Grid */}
      {isLoading && inscriptions.length === 0 ? (
        <div className="myinsc-empty">
          <div className="activity-empty-pulse" />
          <p>Loading your mints from the blockchain…</p>
          <span style={{ color: '#6d5b97', fontSize: '0.8rem' }}>Scanning Monad blocks</span>
        </div>
      ) : inscriptions.length === 0 ? (
        <div className="myinsc-empty">
          <Coins size={36} />
          <h3>No {tick} yet</h3>
          <p>Mint your first inscription to start your collection.</p>
          <button className="wallet-btn" onClick={onGoMint}><Zap size={16} /> Go to Mint</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="myinsc-empty">
          <Search size={28} />
          <p>No inscriptions match "{query}".</p>
        </div>
      ) : (
        <div className="myinsc-grid">
          {filtered.map((inc, i) => {
            const idx = mintsCount - (sort === 'newest' ? i : filtered.findIndex(x => x.hash === inc.hash));
            const amtStr = String(Number(inc.amount) || 0);
            return (
              <div key={inc.hash} className="myinsc-card insc-card-v2">
                {/* VSCode-style inscription JSON preview */}
                <div className="insc-card-preview">
                  <div className="insc-card-preview-glow" />
                  <div className="insc-card-preview-noise" aria-hidden="true" />
                  <div className="insc-card-preview-chrome">
                    <span className="dot r" /><span className="dot y" /><span className="dot g" />
                    <span className="insc-card-preview-fname">inscription.json</span>
                    <span className="insc-card-preview-idx">#{idx}</span>
                  </div>
                  <pre className="insc-card-preview-code" aria-hidden="true">
                    <span className="ln-row"><span className="ln">1</span><span className="tok pn">{'{'}</span></span>
                    <span className="ln-row"><span className="ln">2</span>{'  '}<span className="tok k">"p"</span><span className="tok pn">: </span><span className="tok s">"mon-20"</span><span className="tok pn">,</span></span>
                    <span className="ln-row"><span className="ln">3</span>{'  '}<span className="tok k">"op"</span><span className="tok pn">: </span><span className="tok s">"mint"</span><span className="tok pn">,</span></span>
                    <span className="ln-row"><span className="ln">4</span>{'  '}<span className="tok k">"tick"</span><span className="tok pn">: </span><span className="tok s">"{tick}"</span><span className="tok pn">,</span></span>
                    <span className="ln-row"><span className="ln">5</span>{'  '}<span className="tok k">"amt"</span><span className="tok pn">: </span><span className="tok n">"{amtStr}"</span></span>
                    <span className="ln-row"><span className="ln">6</span><span className="tok pn">{'}'}</span></span>
                  </pre>
                </div>

                {/* On-chain metadata strip */}
                <div className="insc-card-meta">
                  <div className="insc-card-meta-row">
                    <span className="insc-card-meta-label">AMOUNT</span>
                    <span className="insc-card-meta-value strong">+{Number(inc.amount).toLocaleString()} {tick}</span>
                  </div>
                  <div className="insc-card-meta-row">
                    <span className="insc-card-meta-label">TX</span>
                    <button className="insc-card-meta-value mono link" onClick={() => copy(inc.hash)} title={inc.hash}>
                      {copied === inc.hash ? <CheckCircle size={11} /> : <Copy size={11} />}
                      <span>{fmtAddrShort(inc.hash)}</span>
                    </button>
                  </div>
                  {inc.block ? (
                    <div className="insc-card-meta-row">
                      <span className="insc-card-meta-label">BLOCK</span>
                      <span className="insc-card-meta-value mono">#{inc.block}</span>
                    </div>
                  ) : null}
                  <div className="insc-card-meta-row">
                    <span className="insc-card-meta-label">MINTED</span>
                    <span className="insc-card-meta-value" title={new Date((inc.timestamp || 0) * 1000).toLocaleString()}>
                      {relTime(inc.timestamp)}
                    </span>
                  </div>
                  <div className="insc-card-meta-row">
                    <span className="insc-card-meta-label">OWNER</span>
                    <span className="insc-card-meta-value mono mut" title={account}>
                      {fmtAddrShort(account)}
                    </span>
                  </div>
                </div>

                <a
                  className="insc-card-explorer"
                  href={`https://monadvision.com/tx/${inc.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on Monad explorer"
                >
                  <ExternalLink size={12} />
                  <span>View on explorer</span>
                </a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default App;
