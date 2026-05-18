require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 800 },
      viaIR: true,
    },
  },
  networks: {
    monad: {
      url: process.env.RPC_URL || 'https://rpc.monad.xyz',
      chainId: 143,
      accounts,
    },
  },
};
