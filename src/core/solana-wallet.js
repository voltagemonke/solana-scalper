/**
 * Native Solana Wallet Integration
 * Uses local keypair derived from seed phrase - no Venly dependency
 */

import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as bip39 from 'bip39';
// ed25519-hd-key not needed - using direct seed method
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

// Solana derivation path (Phantom/Solflare compatible)
const DERIVATION_PATH = "m/44'/501'/0'/0'";

// RPC endpoint
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

let _keypair = null;
let _connection = null;

/**
 * Get or create the keypair from seed phrase
 */
function getKeypair() {
  if (_keypair) return _keypair;
  
  const seedPhrase = process.env.SOLANA_SEED_PHRASE;
  if (!seedPhrase) {
    throw new Error('SOLANA_SEED_PHRASE not found in environment');
  }
  
  // Validate mnemonic
  if (!bip39.validateMnemonic(seedPhrase.trim())) {
    throw new Error('Invalid seed phrase');
  }
  
  // Derive seed and use first 32 bytes directly (Solana CLI style)
  const seed = bip39.mnemonicToSeedSync(seedPhrase.trim());
  _keypair = Keypair.fromSeed(seed.slice(0, 32));
  
  console.log(`[SolanaWallet] Loaded wallet: ${_keypair.publicKey.toBase58()}`);
  return _keypair;
}

/**
 * Get Solana connection
 */
function getConnection() {
  if (_connection) return _connection;
  _connection = new Connection(RPC_URL, 'confirmed');
  return _connection;
}

/**
 * Get wallet address
 */
export function getAddress() {
  return getKeypair().publicKey.toBase58();
}

/**
 * Get wallet balance in SOL
 */
export async function getBalance() {
  const connection = getConnection();
  const keypair = getKeypair();
  const lamports = await connection.getBalance(keypair.publicKey);
  return lamports / 1e9;
}

/**
 * Get token balance for an SPL token
 */
export async function getTokenBalance(mintAddress) {
  const connection = getConnection();
  const keypair = getKeypair();
  
  try {
    const mint = new PublicKey(mintAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { mint }
    );
    
    if (tokenAccounts.value.length === 0) return 0;
    
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch (e) {
    console.error(`[SolanaWallet] Error getting token balance: ${e.message}`);
    return 0;
  }
}

/**
 * Sign a transaction
 */
export function signTransaction(transaction) {
  const keypair = getKeypair();
  
  if (transaction instanceof VersionedTransaction) {
    transaction.sign([keypair]);
  } else {
    transaction.sign(keypair);
  }
  
  return transaction;
}

/**
 * Send a signed transaction
 */
export async function sendTransaction(transaction, options = {}) {
  const connection = getConnection();
  const keypair = getKeypair();
  
  try {
    let signature;
    
    if (transaction instanceof VersionedTransaction) {
      // Versioned transaction (Jupiter uses these)
      signature = await connection.sendTransaction(transaction, {
        skipPreflight: options.skipPreflight || false,
        maxRetries: options.maxRetries || 3,
      });
    } else {
      // Legacy transaction
      signature = await sendAndConfirmTransaction(connection, transaction, [keypair], {
        skipPreflight: options.skipPreflight || false,
      });
    }
    
    console.log(`[SolanaWallet] Transaction sent: ${signature}`);
    return { success: true, signature };
  } catch (e) {
    console.error(`[SolanaWallet] Transaction failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Sign and send raw transaction bytes (for Jupiter swaps)
 */
export async function signAndSendRawTransaction(serializedTransaction, options = {}) {
  const connection = getConnection();
  const keypair = getKeypair();
  
  try {
    // Deserialize the transaction
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(serializedTransaction, 'base64')
    );
    
    // Sign it
    transaction.sign([keypair]);
    
    // Send it
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: options.skipPreflight || false,
      maxRetries: options.maxRetries || 3,
    });
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log(`[SolanaWallet] Swap executed: ${signature}`);
    return { success: true, signature };
  } catch (e) {
    console.error(`[SolanaWallet] Swap failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Verify wallet is working
 */
export async function verify() {
  try {
    const address = getAddress();
    const balance = await getBalance();
    console.log(`[SolanaWallet] Verified: ${address} | Balance: ${balance.toFixed(6)} SOL`);
    return { success: true, address, balance };
  } catch (e) {
    console.error(`[SolanaWallet] Verification failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

export default {
  getAddress,
  getBalance,
  getTokenBalance,
  signTransaction,
  sendTransaction,
  signAndSendRawTransaction,
  verify,
};
