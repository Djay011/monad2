// EIP-6963 multi-wallet discovery + legacy fallback.
// Supports MetaMask, Rabby, Phantom (EVM), Coinbase Wallet, OKX, Trust, etc.
import { useEffect, useState, useCallback } from 'react';

const LS_KEY = 'mi_selected_wallet_rdns';

/**
 * Returns the list of currently injected EVM providers, deduped by rdns.
 * Re-emits on `eip6963:announceProvider` events so newly-installed wallets
 * (or wallets that announce late) appear without a page reload.
 */
export function useInjectedWallets() {
  const [wallets, setWallets] = useState([]);

  useEffect(() => {
    const map = new Map();

    const onAnnounce = (event) => {
      const detail = event.detail;
      if (!detail || !detail.info || !detail.provider) return;
      const rdns = detail.info.rdns || detail.info.uuid || detail.info.name;
      if (!rdns) return;
      map.set(rdns, {
        rdns,
        uuid: detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon,
        provider: detail.provider,
      });
      setWallets(Array.from(map.values()));
    };

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    // Legacy fallbacks for wallets that didn't implement EIP-6963.
    const legacyProviders = [];
    if (window.ethereum) {
      if (Array.isArray(window.ethereum.providers)) {
        legacyProviders.push(...window.ethereum.providers);
      } else {
        legacyProviders.push(window.ethereum);
      }
    }
    // Phantom exposes its EVM provider here even when window.ethereum is taken
    // by another wallet (e.g. MetaMask). Same for Coinbase.
    if (window.phantom && window.phantom.ethereum) {
      legacyProviders.push(window.phantom.ethereum);
    }
    if (window.coinbaseWalletExtension) {
      legacyProviders.push(window.coinbaseWalletExtension);
    }

    legacyProviders.forEach((p, i) => {
      if (!p) return;
      const name =
        (p.isPhantom && 'Phantom') ||
        (p.isRabby && 'Rabby') ||
        (p.isMetaMask && !p.isBraveWallet && 'MetaMask') ||
        (p.isCoinbaseWallet && 'Coinbase Wallet') ||
        (p.isOkxWallet && 'OKX Wallet') ||
        (p.isTrust && 'Trust Wallet') ||
        (p.isBraveWallet && 'Brave Wallet') ||
        `Injected #${i + 1}`;
      const rdns = `legacy:${name}`;
      if (!map.has(rdns) && !Array.from(map.values()).some(w => w.provider === p)) {
        map.set(rdns, { rdns, name, icon: null, provider: p });
      }
    });
    if (map.size > 0) setWallets(Array.from(map.values()));

    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
    };
  }, []);

  return wallets;
}

export function rememberWallet(rdns) {
  try { localStorage.setItem(LS_KEY, rdns); } catch {}
}
export function rememberedWallet() {
  try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; }
}
export function forgetWallet() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

/**
 * Picks a provider for silent reconnect on page load: prefers the previously
 * remembered wallet, otherwise returns null (user must explicitly choose).
 */
export function useAutoProvider(wallets) {
  const remembered = rememberedWallet();
  if (!remembered) return null;
  const w = wallets.find(x => x.rdns === remembered);
  return w ? w.provider : null;
}

/** Tiny helper: request the chain switch on a specific provider (not window.ethereum). */
export async function switchOrAddChain(provider, chainHex, addParams) {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainHex }],
    });
  } catch (err) {
    if (err && err.code === 4902 && addParams) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [addParams] });
    } else {
      throw err;
    }
  }
}

/** Prebuilt wallet picker modal. */
export function WalletPicker({ open, wallets, onPick, onClose }) {
  if (!open) return null;
  return (
    <div className="wallet-picker-backdrop" onClick={onClose}>
      <div className="wallet-picker" onClick={(e) => e.stopPropagation()}>
        <div className="wallet-picker-head">
          <h3>Connect a wallet</h3>
          <button className="wallet-picker-close" onClick={onClose}>×</button>
        </div>
        <p className="wallet-picker-sub">
          Choose any EVM-compatible wallet. We support every wallet that
          implements the standard injected provider API.
        </p>
        {wallets.length === 0 ? (
          <div className="wallet-picker-empty">
            <p>No EVM wallets detected.</p>
            <span>Install MetaMask, Rabby, Phantom, Coinbase Wallet, or any EIP-6963 wallet.</span>
          </div>
        ) : (
          <div className="wallet-picker-list">
            {wallets.map((w) => (
              <button key={w.rdns} className="wallet-picker-item" onClick={() => onPick(w)}>
                {w.icon
                  ? <img src={w.icon} alt="" className="wallet-picker-icon" />
                  : <div className="wallet-picker-icon fallback">{w.name.slice(0, 1)}</div>}
                <span className="wallet-picker-name">{w.name}</span>
                <span className="wallet-picker-arrow">›</span>
              </button>
            ))}
          </div>
        )}
        <p className="wallet-picker-hint">
          By connecting, you agree to interact with the Monad blockchain through your wallet.
        </p>
      </div>
    </div>
  );
}

/** Convenience hook to drive the picker: open/pick/close + auto-reconnect. */
export function useWalletPicker() {
  const wallets = useInjectedWallets();
  const [open, setOpen] = useState(false);
  const openPicker = useCallback(() => setOpen(true), []);
  const closePicker = useCallback(() => setOpen(false), []);
  return { wallets, open, openPicker, closePicker };
}
