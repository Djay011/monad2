
import { ethers } from 'ethers';

async function checkBalance() {
    try {
        const provider = new ethers.JsonRpcProvider('https://testnet-rpc.monad.xyz');
        const wallet = '0xc3426581b4531B0339410c39FA14AF640fBe3aD8';
        const balance = await provider.getBalance(wallet);
        console.log('Balance in MON:', ethers.formatEther(balance));
    } catch (e) {
        console.error('Error fetching balance:', e);
    }
}

checkBalance();
