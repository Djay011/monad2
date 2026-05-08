import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ethers } from 'ethers';
import { Wallet, CheckCircle, AlertCircle, LogOut, Zap, Shield, Layers, Globe, Rocket, Target } from 'lucide-react';

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
const RECEIVER_WALLET = '0xc3426581b4531B0339410c39FA14AF640fBe3aD8';
const MINT_PRICE = '0.00002'; // 0.00002 MON
const INSCRIPTION_DATA = 'data:application/json,{"p":"mon-20","op":"mint","tick":"rave","amt":"1000"}';
const TOTAL_SUPPLY = 21000000;
const MINT_AMOUNT = 1000;
const INITIAL_MINTED = 0; // Set your starting progress here (e.g. 10M)
const INITIAL_WALLET_BALANCE = 8.124440917972837; // Current wallet balance as of today

function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState('');
  const [balance, setBalance] = useState('0.00');
  const [network, setNetwork] = useState(null);

  const [totalMinted, setTotalMinted] = useState(0); // Will be updated with real on-chain data
  const [myInscriptions, setMyInscriptions] = useState(() => {
    try {
      const saved = localStorage.getItem('rave_inscriptions');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [repeatCount, setRepeatCount] = useState(1);

  const getInitialTab = () => {
    const path = window.location.pathname;
    if (path === '/My-Inscriptions') return 'inscriptions';
    if (path === '/mint') return 'mint';
    if (path === '/marketplace') return 'marketplace';
    return 'about'; // Default to about for / or unknown paths
  };
  const [activeTab, setActiveTab] = useState(getInitialTab);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    const pathMap = { inscriptions: '/My-Inscriptions', about: '/', mint: '/mint', marketplace: '/marketplace' };
    window.history.pushState(null, '', pathMap[tab] || '/');
  };

  useEffect(() => {
    const handlePopState = () => {
      setActiveTab(getInitialTab());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const [isMinting, setIsMinting] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '' }); // type: 'waiting', 'success', 'error'

  const fetchTotalMinted = useCallback(async () => {
    try {
      const rpcProvider = new ethers.JsonRpcProvider(TARGET_NETWORK.rpcUrls[0]);
      const bal = await rpcProvider.getBalance(RECEIVER_WALLET);

      let realTotalMinted = INITIAL_MINTED;

      // Only calculate from balance if price > 0 — use BigInt math to avoid float precision loss
      if (Number(MINT_PRICE) > 0) {
        const initialBalanceWei = ethers.parseEther(INITIAL_WALLET_BALANCE.toString());
        const priceWei = ethers.parseEther(MINT_PRICE);
        let newBalanceWei = bal - initialBalanceWei;
        if (newBalanceWei < 0n) newBalanceWei = 0n;

        const mintsFromBalance = Number(newBalanceWei / priceWei);
        realTotalMinted += (mintsFromBalance * MINT_AMOUNT);
      }

      if (realTotalMinted > TOTAL_SUPPLY) realTotalMinted = TOTAL_SUPPLY;
      return realTotalMinted;
    } catch (err) {
      console.error("Failed to fetch real minted amount", err);
      return null;
    }
  }, []);

  const checkConnection = useCallback(async () => {
    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
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
  }, []);

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

  // Compute totalMinted from local inscriptions when price is 0 (derived state)
  const localTotalMinted = useMemo(() => {
    if (Number(MINT_PRICE) === 0) {
      const localMints = myInscriptions.reduce((acc, curr) => acc + curr.amount, 0);
      let newTotal = INITIAL_MINTED + localMints;
      if (newTotal > TOTAL_SUPPLY) newTotal = TOTAL_SUPPLY;
      return newTotal;
    }
    return null;
  }, [myInscriptions]);

  // Save inscriptions to localStorage
  useEffect(() => {
    localStorage.setItem('rave_inscriptions', JSON.stringify(myInscriptions));
  }, [myInscriptions]);

  // Sync localTotalMinted into state when price is 0
  useEffect(() => {
    if (localTotalMinted !== null) {
      const id = requestAnimationFrame(() => setTotalMinted(localTotalMinted));
      return () => cancelAnimationFrame(id);
    }
  }, [localTotalMinted]);

  // Fetch real minted amount and set up event listeners on mount
  useEffect(() => {
    let isMounted = true;

    fetchTotalMinted().then((result) => {
      if (isMounted && result !== null) {
        setTotalMinted(result);
      }
    });

    const handleChainChanged = () => window.location.reload();

    if (window.ethereum) {
      window.ethereum.on('accountsChanged', handleAccountsChanged);
      window.ethereum.on('chainChanged', handleChainChanged);

      // Initial check if already connected — deferred to avoid sync setState
      queueMicrotask(() => checkConnection());
    }

    return () => {
      isMounted = false;
      if (window.ethereum) {
        window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
        window.ethereum.removeListener('chainChanged', handleChainChanged);
      }
    };
  }, [fetchTotalMinted, handleAccountsChanged, checkConnection]);

  const connectWallet = async () => {
    if (!window.ethereum) {
      setStatus({ type: 'error', message: 'Please install MetaMask to mint.' });
      return;
    }

    try {
      setStatus({ type: '', message: '' });
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      await browserProvider.send("eth_requestAccounts", []);

      const currentSigner = await browserProvider.getSigner();
      const address = await currentSigner.getAddress();
      const net = await browserProvider.getNetwork();
      const bal = await browserProvider.getBalance(address);

      setProvider(browserProvider);
      setSigner(currentSigner);
      setAccount(address);
      setBalance(Number(ethers.formatEther(bal)).toFixed(4));
      setNetwork(net);

      await checkAndSwitchNetwork(browserProvider);
    } catch (err) {
      console.error(err);
      setStatus({ type: 'error', message: 'Failed to connect wallet.' });
    }
  };

  const disconnectWallet = () => {
    setAccount('');
    setSigner(null);
    setProvider(null);
    setBalance('0.00');
    setNetwork(null);
    setStatus({ type: '', message: 'Wallet disconnected' });
    setTimeout(() => setStatus({ type: '', message: '' }), 3000);
  };

  const checkAndSwitchNetwork = async (prov) => {
    const net = await prov.getNetwork();
    const currentChainId = '0x' + net.chainId.toString(16);

    if (currentChainId.toLowerCase() !== MONAD_CHAIN_ID.toLowerCase()) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: MONAD_CHAIN_ID }],
        });
      } catch (switchError) {
        // This error code indicates that the chain has not been added to MetaMask.
        if (switchError.code === 4902) {
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [TARGET_NETWORK],
            });
          } catch {
            setStatus({ type: 'error', message: 'Failed to add Monad network.' });
          }
        } else {
          setStatus({ type: 'error', message: 'Failed to switch to Monad network.' });
        }
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
      const customDataString = `data:application/json,{"p":"mon-20","op":"mint","tick":"rave","amt":"${totalAmountToMint}"}`;
      const hexData = ethers.hexlify(ethers.toUtf8Bytes(customDataString));

      const txRequest = {
        to: RECEIVER_WALLET,
        value: totalValue,
        data: hexData
      };

      // Send the single transaction
      const tx = await signer.sendTransaction(txRequest);

      setStatus({ type: 'waiting', message: `Transaction submitted! Waiting for block...` });

      // Wait for confirmation
      await tx.wait();

      // Refresh real minted count from chain
      const updatedMinted = await fetchTotalMinted();
      if (updatedMinted !== null) {
        setTotalMinted(updatedMinted);
      }

      setMyInscriptions(prev => [
        {
          hash: tx.hash,
          amount: totalAmountToMint,
          time: new Date().toLocaleString()
        },
        ...prev
      ]);

      setStatus({ type: 'success', message: `Success! ${totalAmountToMint.toLocaleString()} rave Minted` });

    } catch (err) {
      console.error(err);
      let errMsg = 'Transaction Failed';
      if (err.code === 'ACTION_REJECTED' || err.info?.error?.code === 4001) {
        errMsg = 'Transaction rejected by user.';
      } else if (err.info?.error?.message) {
        errMsg = err.info.error.message;
      } else if (err.reason) {
        errMsg = err.reason;
      }
      setStatus({ type: 'error', message: `Error: ${errMsg}` });
    }

    setIsMinting(false);
  };

  const formatAddress = (addr) => {
    return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
  };

  return (
    <div className="app-container">
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
          <div className="mint-card-new">
            <div className="mint-card-top">
              <span className="minting-label">MINTING</span>
              <span className="minting-ticker">$rave</span>
            </div>

            <div className="progress-text-row">
              <span className="progress-percentage">{totalMinted > 0 ? ((totalMinted / TOTAL_SUPPLY) * 100).toFixed(4) : 0}%</span>
              <span className="progress-numbers">{totalMinted.toLocaleString()} / {TOTAL_SUPPLY.toLocaleString()} rave</span>
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
  "tick": "rave",
  "amt": "${repeatCount * MINT_AMOUNT}"
}`}
              </pre>
            </div>

            <div className="fee-summary-box">
              <div className="fee-row">
                <span>Total Tokens</span>
                <span>{repeatCount} × {MINT_AMOUNT.toLocaleString()} = {(repeatCount * MINT_AMOUNT).toLocaleString()} rave</span>
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
        )}

        {activeTab === 'inscriptions' && (
          <div className="inscriptions-section">
            <div className="inscriptions-page-header">
              <h2 className="inscriptions-header">My Inscriptions</h2>
              <div className="total-pepo-badge">
                Total Balance: {myInscriptions.reduce((acc, curr) => acc + curr.amount, 0).toLocaleString()} rave
              </div>
            </div>

            {myInscriptions.length === 0 ? (
              <div className="empty-state">
                <p>You haven't minted any rave yet.</p>
                <button className="wallet-btn" onClick={() => handleTabChange('mint')}>Go Mint</button>
              </div>
            ) : (
              <div className="inscriptions-list">
                {myInscriptions.map((inc, index) => (
                  <div key={index} className="inscription-item">
                    <div className="inscription-info">
                      <span className="inscription-amount">{inc.amount} rave</span>
                      <span className="inscription-hash">
                        Tx: <a href={`https://monadvision.com/tx/${inc.hash}`} target="_blank" rel="noopener noreferrer">
                          {formatAddress(inc.hash)}
                        </a>
                      </span>
                    </div>
                    <div className="inscription-date">{inc.time}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'marketplace' && (
          <div className="about-page">
            <div className="about-hero">
              <div className="about-hero-glow"></div>
              <h1 className="about-title">Marketplace</h1>
              <p className="about-subtitle">
                The MON-20 marketplace is under construction. Soon you'll be able to list, buy,
                and trade rave inscriptions peer-to-peer on Monad.
              </p>
              <button className="about-cta" onClick={() => handleTabChange('mint')}>
                <Rocket size={18} />
                Mint in the meantime
              </button>
            </div>
          </div>
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
      </main>

      <footer>
        <p>Built for the Monad Ecosystem</p>
      </footer>
    </div>
  );
}

export default App;
