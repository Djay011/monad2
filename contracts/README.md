# MonadInscriptionMarket — Smart Contract

Non-custodial peer-to-peer marketplace contract for MON-20 inscriptions.
Charges a **5% protocol fee** on every successful trade, sent to a configurable
fee recipient.

## Layout

```
contracts/
├── contracts/
│   └── MonadInscriptionMarket.sol
├── scripts/
│   └── deploy.js
├── hardhat.config.js
├── package.json
└── .env.example
```

## Behavior

| Action          | Caller    | Effect                                                 |
| --------------- | --------- | ------------------------------------------------------ |
| `list(...)`     | seller    | Records on-chain listing, emits `Listed`               |
| `buy(id)`       | buyer     | Pays seller (95%) and `feeRecipient` (5%), emits `Sold`|
| `cancel(id)`    | seller    | Marks listing inactive, emits `Cancelled`              |

**Reentrancy-safe**: state flips before any external call (Checks-Effects-Interactions).

## Deploy

```bash
cd contracts
cp .env.example .env       # paste deployer PRIVATE_KEY
npm install
npm run compile
npm run deploy
```

The deploy script prints the deployed address and the env line to add to the
frontend:

```
VITE_MARKET_CONTRACT=0x...
```

## Fee configuration

The fee recipient is set immutably at construction time. To change it,
redeploy with a different `FEE_RECIPIENT`. The fee rate is hard-coded at
**500 bps (5%)** for predictability.

Default fee recipient: `0x6fC09727F83Ef23782cF80Cd11e1bda534532267`

## ABI for frontend

After `npm run compile`, the ABI is at:

```
contracts/artifacts/contracts/MonadInscriptionMarket.sol/MonadInscriptionMarket.json
```

The frontend (`src/marketAbi.js`) ships a hand-written minimal ABI matching
the on-chain interface; no copy step required.

## Verifying on a block explorer

When MonadVision (or another explorer) supports source verification, run:

```bash
npx hardhat verify --network monad <DEPLOYED_ADDRESS> 0x6fC09727F83Ef23782cF80Cd11e1bda534532267
```
