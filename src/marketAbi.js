// Minimal ABI for MonadInscriptionMarket — kept here so the frontend doesn't
// have to import Hardhat artifacts.

export const MARKET_ABI = [
  'function feeRecipient() view returns (address)',
  'function FEE_BPS() view returns (uint16)',
  'function nextId() view returns (uint256)',
  'function listings(uint256) view returns (address seller, uint96 priceWei, bytes32 tick, uint256 amount, bool active)',
  'function quote(uint96 priceWei) view returns (uint256 sellerAmt, uint256 feeAmt)',
  'function list(bytes32 tick, uint256 amount, uint96 priceWei) returns (uint256 id)',
  'function buy(uint256 id) payable',
  'function cancel(uint256 id)',
  'event Listed(uint256 indexed id, address indexed seller, bytes32 indexed tick, uint256 amount, uint96 priceWei)',
  'event Sold(uint256 indexed id, address indexed buyer, address indexed seller, bytes32 tick, uint256 amount, uint96 priceWei, uint256 feePaid)',
  'event Cancelled(uint256 indexed id, address indexed seller)',
];

export const MARKET_CONTRACT_ADDRESS =
  import.meta.env.VITE_MARKET_CONTRACT || '';

export const FEE_BPS = 500;
export const FEE_PERCENT = FEE_BPS / 100; // 5
