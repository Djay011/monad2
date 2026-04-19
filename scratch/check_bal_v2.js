
import { ethers } from 'ethers';

async function checkBalance() {
    try {
        const rpcs = [
            'https://rpc.monad.xyz',
            'https://testnet-rpc.monad.xyz'
        ];
        const wallet = '0xc3426581b4531B0339410c39FA14AF640fBe3aD8';
        
        for (const url of rpcs) {
            const provider = new ethers.JsonRpcProvider(url);
            const balance = await provider.getBalance(wallet);
            console.log(`Balance on ${url}:`, ethers.formatEther(balance));
        }
    } catch (e) {
        console.error('Error fetching balance:', e);
    }
}

checkBalance();
