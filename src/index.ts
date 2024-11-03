import {MongoClient} from 'mongodb';
import {Connection, Keypair, PublicKey, VersionedTransaction} from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import fetch from 'cross-fetch';
import {Wallet} from '@project-serum/anchor';
import bs58 from 'bs58';
import path from "path";
import dotenv from "dotenv";

const envPath = path.join(__dirname, ".env");
dotenv.config({
    path: envPath,
});

const MONGO_URI = 'mongodb://localhost:27017';
const DB_NAME = 'dexscreener';
const COLLECTION_NAME = 'tokens';
console.log("..." + envPath)
console.log("..." + process.env["PRIVATE_KEY"])
const connection = new Connection("https://mainnet.helius-rpc.com/?api-key="+process.env["API_KEY"]);
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env["PRIVATE_KEY"] || '')));

const client = new MongoClient(MONGO_URI);
client.connect();
const db = client.db(DB_NAME);
const collection = db.collection(COLLECTION_NAME);

const WSOL_MINT_ADDRESS = new PublicKey('So11111111111111111111111111111111111111112');

async function getWSOLBalance() {
    try {
        // 获取 WSOL 的关联账户地址
        const associatedTokenAddress = await getAssociatedTokenAddress(
            WSOL_MINT_ADDRESS,
            wallet.publicKey
        );
        // 获取账户信息
        const accountInfo = await getAccount(connection, associatedTokenAddress);
        // 打印 WSOL 的余额
        console.log('WSOL balance:', Number(accountInfo.amount) / 1e9, 'WSOL');
        return Number(accountInfo.amount);
    } catch (error) {
        console.error('Error fetching WSOL balance:', error);
        return 0;
    }
}

async function getWalletBalance() {
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        console.log('Wallet balance:', balance / 1e9, 'SOL');
        return balance;
    } catch (error) {
        return 0;
    }
}

// 0:初始化，1:正在运行，2：暂时无盈利，可计入笛卡尔积运算，3：api报错，放弃运算，4：损失巨大放弃运算

async function processToken(token: any): Promise<void> {
    return new Promise(async (resolve, reject) => {
        let initAmount = 10000000; //0.01 SOL
        while (true) {
            const baseAmount = await getWalletBalance();
            const baseWAmount = await getWSOLBalance();
            if(baseAmount <= initAmount && baseWAmount <= initAmount){
                console.log('Wallet balance is less than initamount');
                break;
            }
            const quoteFirst = await (
                await fetch('https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint='+token.tokenAddress+'&amount='+initAmount+'&slippageBps=10')
            ).json();
            const quoteSecond = await (
                await fetch('https://quote-api.jup.ag/v6/quote?inputMint='+token.tokenAddress+'&outputMint=So11111111111111111111111111111111111111112&amount=' + quoteFirst.outAmount + '&slippageBps=10')
            ).json();
            console.log(quoteFirst);
            console.log(quoteSecond);
            if(quoteFirst.error || quoteSecond.error){
                await collection.updateOne(
                    {tokenAddress: token.tokenAddress},
                    {$set: {runstatus: 3}}
                );
                break;
            }
            const resultAmount = (quoteSecond.outAmount - initAmount) / initAmount

            if (resultAmount <= -0.05) {
                console.log('too huge.');
                await collection.updateOne(
                    {tokenAddress: token.tokenAddress},
                    {$set: {runstatus: 4}}
                );
                break;
            }
            else if(resultAmount >= 0.01){
                console.log('get into compute ledger.');
                await collection.updateOne(
                    {tokenAddress: token.tokenAddress},
                    {$set: {runstatus: 1}}
                );
                const quoteFirstSwap = await (
                    await fetch('https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint='+token.tokenAddress+'&amount='+initAmount+'&slippageBps=10')
                ).json();
                const { swapTransactionFirst } = await (
                    await fetch('https://quote-api.jup.ag/v6/swap', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            // quoteResponse from /quote api
                            quoteFirstSwap,
                            // user public key to be used for the swap
                            userPublicKey: wallet.publicKey.toString(),
                            // auto wrap and unwrap SOL. default is true
                            wrapAndUnwrapSol: true,
                            // feeAccount is optional. Use if you want to charge a fee.  feeBps must have been passed in /quote API.
                            // feeAccount: "fee_account_public_key"
                        })
                    })
                ).json();
                console.log('......'+swapTransactionFirst);
                // deserialize the transaction
                let swapTransactionBuf = Buffer.from(swapTransactionFirst, 'base64');
                var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                console.log(transaction);
                // sign the transaction
                transaction.sign([wallet.payer]);
                // get the latest block hash
                const latestBlockHash = await connection.getLatestBlockhash();
                // Execute the transaction
                const rawTransaction = transaction.serialize()
                const txid = await connection.sendRawTransaction(rawTransaction, {
                    skipPreflight: true,
                    maxRetries: 2
                });
                await connection.confirmTransaction({
                    blockhash: latestBlockHash.blockhash,
                    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
                    signature: txid
                });
                console.log(`https://solscan.io/tx/${txid}`);

                const quoteSecondSwap = await (
                    await fetch('https://quote-api.jup.ag/v6/quote?inputMint='+token.tokenAddress+'&outputMint=So11111111111111111111111111111111111111112&amount=' + quoteFirstSwap.outAmount + '&slippageBps=10')
                ).json();
                const { swapTransactionSecond } = await (
                    await fetch('https://quote-api.jup.ag/v6/swap', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            // quoteResponse from /quote api
                            quoteSecondSwap,
                            // user public key to be used for the swap
                            userPublicKey: wallet.publicKey.toString(),
                            // auto wrap and unwrap SOL. default is true
                            wrapAndUnwrapSol: true,
                            // feeAccount is optional. Use if you want to charge a fee.  feeBps must have been passed in /quote API.
                            // feeAccount: "fee_account_public_key"
                        })
                    })
                ).json();
                console.log('......'+swapTransactionSecond);
                // deserialize the transaction
                swapTransactionBuf = Buffer.from(swapTransactionSecond, 'base64');
                transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                console.log(transaction);
                // sign the transaction
                transaction.sign([wallet.payer]);
                // get the latest block hash
                const latestBlockHashT = await connection.getLatestBlockhash();
                // Execute the transaction
                const rawTransactionT = transaction.serialize()
                const txidT = await connection.sendRawTransaction(rawTransactionT, {
                    skipPreflight: true,
                    maxRetries: 2
                });
                await connection.confirmTransaction({
                    blockhash: latestBlockHashT.blockhash,
                    lastValidBlockHeight: latestBlockHashT.lastValidBlockHeight,
                    signature: txidT
                });
                console.log(`https://solscan.io/tx/${txidT}`);
            }
            else{
                console.log('later.');
                await collection.updateOne(
                    {tokenAddress: token.tokenAddress},
                    {$set: {runstatus: 2}}
                );
                break;
            }
        }

        resolve();
    });
}

async function queryDatabase() {
    try {
        const tokens = await collection.find({ runstatus: 0 }).toArray();
        if (tokens.length === 0) {
            console.log('No tokens found. Waiting 1 minutes...');
            await new Promise(resolve => setTimeout(resolve, 100000));
        } else {
            for (const token of tokens) {
                try {
                    console.log(`Processing token: ${token.tokenAddress}`);
                    await processToken(token);
                } catch (error) {
                    console.error(`Error processing token ${token.tokenAddress}:`, error);
                    await collection.updateOne(
                        {tokenAddress: token.tokenAddress},
                        {$set: {runstatus: 1000}}
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