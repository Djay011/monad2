const hre = require('hardhat');

const FEE_RECIPIENT = process.env.FEE_RECIPIENT
  || '0x6fC09727F83Ef23782cF80Cd11e1bda534532267';

async function main() {
  if (!/^0x[a-fA-F0-9]{40}$/.test(FEE_RECIPIENT)) {
    throw new Error(`Invalid FEE_RECIPIENT: ${FEE_RECIPIENT}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log('Deployer:', deployer.address);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log('Balance :', hre.ethers.formatEther(bal), 'MON');

  const Factory = await hre.ethers.getContractFactory('MonadInscriptionMarket');
  const market = await Factory.deploy(FEE_RECIPIENT);
  await market.waitForDeployment();

  const addr = await market.getAddress();
  console.log('\nMonadInscriptionMarket deployed at:', addr);
  console.log('Fee recipient:                     ', FEE_RECIPIENT);
  console.log('Fee bps:                            500 (5%)');
  console.log('\nAdd this to your frontend .env:');
  console.log(`VITE_MARKET_CONTRACT=${addr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
