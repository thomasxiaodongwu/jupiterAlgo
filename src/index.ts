import {MongoClient} from 'mongodb';
import {Connection, Keypair, VersionedTransaction} from '@solana/web3.js';
import fetch from 'cross-fetch';
import {Wallet} from '@project-serum/anchor';
import bs58 from 'bs58';

const MONGO_URI = 'mongodb://localhost:27017';
const DB_NAME = 'dexscreener';
const COLLECTION_NAME = 'tokens';
const connection = new Connection("https://mainnet.helius-rpc.com/?api-key="+process.env.API_KEY);
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || '')));

const client = new MongoClient(MONGO_URI);
client.connect();
const db = client.db(DB_NAME);
const collection = db.collection(COLLECTION_NAME);

async function getWalletBalance() {
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        console.log('Wallet balance:', balance / 1e9, 'SOL');
        return balance;
    } catch (error) {
        return 0;
    }
}

async function processToken(token: any): Promise<void> {
    return new Promise(async (resolve, reject) => {
        let initAmount = 100000000; //0.1 SOL
        while (true) {
            const baseAmount = await getWalletBalance();
            if(baseAmount <= initAmount){
                console.log('Wallet balance is less than initamount');
                break;
            }
            const quoteFirst = await (
                await fetch('https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=5pQSTDfeUppb6tV415RWygL8n3ctyakBTV7QzBn5pump&amount='+initAmount+'&slippageBps=10')
            ).json();
            const quoteSecond = await (
                await fetch('https://quote-api.jup.ag/v6/quote?inputMint=5pQSTDfeUppb6tV415RWygL8n3ctyakBTV7QzBn5pump&outputMint=So11111111111111111111111111111111111111112&amount=' + quoteFirst.outAmount + '&slippageBps=10')
            ).json();
            console.log({ quoteFirst });
            console.log({ quoteSecond });

            if (quoteSecond.outAmount <= initAmount) {
                console.log('A is greater than B, exiting loop.');
                await collection.updateOne(
                    {tokenAddress: token.tokenAddress},
                    {$set: {runstatus: 2}}
                );
                break;
            }else{
                console.log('get into compute ledger.');
                const { swapTransactionFirst } = await (
                    await fetch('https://quote-api.jup.ag/v6/swap', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            // quoteResponse from /quote api
                            quoteFirst,
                            // user public key to be used for the swap
                            userPublicKey: wallet.publicKey.toString(),
                            // auto wrap and unwrap SOL. default is true
                            wrapAndUnwrapSol: true,
                            // feeAccount is optional. Use if you want to charge a fee.  feeBps must have been passed in /quote API.
                            // feeAccount: "fee_account_public_key"
                        })
                    })
                ).json();
                const { swapTransactionSecond } = await (
                    await fetch('https://quote-api.jup.ag/v6/swap', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            // quoteResponse from /quote api
                            quoteSecond,
                            // user public key to be used for the swap
                            userPublicKey: wallet.publicKey.toString(),
                            // auto wrap and unwrap SOL. default is true
                            wrapAndUnwrapSol: true,
                            // feeAccount is optional. Use if you want to charge a fee.  feeBps must have been passed in /quote API.
                            // feeAccount: "fee_account_public_key"
                        })
                    })
                ).json();
                const transactions: VersionedTransaction[] = [];
                const swapTransactionBufFirst = Buffer.from(swapTransactionFirst, 'base64');
                var transactionFirst = VersionedTransaction.deserialize(swapTransactionBufFirst);
                transactionFirst.sign([wallet.payer]);
                transactions.push(transactionFirst);

                const swapTransactionBufSecond = Buffer.from(swapTransactionSecond, 'base64');
                var transactionSecond = VersionedTransaction.deserialize(swapTransactionBufSecond);
                transactionSecond.sign([wallet.payer]);
                transactions.push(transactionSecond);

                const serializedTransactions = transactions.map(tx => tx.serialize());
                const combinedTransaction = Buffer.concat(serializedTransactions);
                console.log('begin sendRawTransaction.' + token.tokenAddress);
                const latestBlockHash = await connection.getLatestBlockhash();
                const txid = await connection.sendRawTransaction(combinedTransaction, {
                    skipPreflight: true,
                    maxRetries: 2
                });
                await connection.confirmTransaction({
                    blockhash: latestBlockHash.blockhash,
                    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
                    signature: txid
                });
                console.log(`https://solscan.io/tx/${txid}`);
            }
        }

        resolve();
    });
}

async function queryDatabase() {
    try {
        const tokens = await collection.find({ runstatus: 0 }).toArray();
        if (tokens.length === 0) {
            console.log('No tokens found. Waiting 10 minutes...');
            await new Promise(resolve => setTimeout(resolve, 600000));
        } else {
            for (const token of tokens) {
                try {
                    console.log(`Processing token: ${token.tokenAddress}`);
                    await collection.updateOne(
                        {tokenAddress: token.tokenAddress},
                        {$set: {runstatus: 1}}
                    );
                    await processToken(token);
                } catch (error) {
                    console.error(`Error processing token ${token.tokenAddress}:`, error);
                    await collection.updateOne(
                        {tokenAddress: token.tokenAddress},
                        {$set: {runstatus: 3}}
                    );
                }
            }
        }
    } catch (error) {
        console.error('some error:', error);
    } finally {
        //await client.close();
    }
}

async function main() {
    while (true) {
        console.log('Querying database...');
        await queryDatabase();
    }
}

main().catch(console.error);