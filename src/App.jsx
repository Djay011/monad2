import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ethers } from 'ethers';
import { Wallet, CheckCircle, AlertCircle, LogOut } from 'lucide-react';

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
  const [activeTab, setActiveTab] = useState('mint'); // 'mint' or 'inscriptions'

  const [isMinting, setIsMinting] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '' }); // type: 'waiting', 'success', 'error'

  const fetchTotalMinted = useCallback(async () => {
    try {
      const rpcProvider = new ethers.JsonRpcProvider(TARGET_NETWORK.rpcUrls[0]);
      const bal = await rpcProvider.getBalance(RECEIVER_WALLET);
      const balanceInMon = ethers.formatEther(bal);

      let realTotalMinted = INITIAL_MINTED;

      // Only calculate from balance if price > 0
      if (Number(MINT_PRICE) > 0) {
        // Subtract old balance so we only count NEW mints
        let newBalance = Number(balanceInMon) - INITIAL_WALLET_BALANCE;
        if (newBalance < 0) newBalance = 0;

        const mintsFromBalance = Math.floor(newBalance / Number(MINT_PRICE));
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

    if (window.ethereum) {
      window.ethereum.on('accountsChanged', handleAccountsChanged);
      window.ethereum.on('chainChanged', () => window.location.reload());

      // Initial check if already connected — deferred to avoid sync setState
      queueMicrotask(() => checkConnection());
    }

    return () => {
      isMounted = false;
      if (window.ethereum) {
        window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
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
      const maxAllowed = (TOTAL_SUPPLY - totalMinted) / MINT_AMOUNT;
      setStatus({ type: 'error', message: `Exceeds limit! Only ${maxAllowed} repeats left.` });
      return;
    }

    // Ensure we are on the right network before minting
    const net = await provider.getNetwork();
    const currentChainId = '0x' + net.chainId.toString(16);
    if (currentChainId.toLowerCase() !== MONAD_CHAIN_ID.toLowerCase()) {
      await checkAndSwitchNetwork(provider);
      // Wait for network switch to complete
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
        <div className="logo">
          Monad Inscription
        </div>

        <nav className="header-nav">
          <a
            href="#"
            className={`nav-link ${activeTab === 'mint' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('mint'); }}
          >Mint</a>
          <a
            href="#"
            className={`nav-link ${activeTab === 'inscriptions' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('inscriptions'); }}
          >My Inscriptions</a>
          <span className="nav-link disabled">Deploy <span className="soon-badge">soon</span></span>
          <span className="nav-link disabled">Marketplace <span className="soon-badge">soon</span></span>
        </nav>

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
                <input type="text" value="1000" readOnly />
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
              {(TOTAL_SUPPLY - totalMinted).toLocaleString()} remaining · limit 1,000
            </p>

            <div className="calldata-preview">
              <label>CALLDATA PREVIEW</label>
              <pre>
                {`{
  "p": "mon-20",
  "op": "mint",
  "tick": "rave",
  "amt": "${repeatCount * 1000}"
}`}
              </pre>
            </div>

            <div className="fee-summary-box">
              <div className="fee-row">
                <span>Total Tokens</span>
                <span>{repeatCount} × 1,000 = {(repeatCount * 1000).toLocaleString()} rave</span>
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
                Total Balance: {myInscriptions.reduce((acc, curr) => acc + curr.amount, 0).toLocaleString()} rave              </div>
            </div>

            {myInscriptions.length === 0 ? (
              <div className="empty-state">
                <p>You haven't minted any rave yet.</p>
                <button className="wallet-btn" onClick={() => setActiveTab('mint')}>Go Mint</button>
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
      </main>

      <footer>
        <p>Built for the Monad Ecosystem • <a href="#" className="link">View Contract</a></p>
      </footer>
    </div>
  );
}

export default App;
