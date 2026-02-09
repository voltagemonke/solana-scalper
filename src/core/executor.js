/**
 * Trade Executor
 * Real swap execution via 1inch/Jupiter + Venly
 */

import fetch from 'node-fetch';
import venly from './venly.js';
import solanaWallet from './solana-wallet.js';
import dex from './dex.js';
import oracle from './oracle.js';
import risk from './risk.js';
import notifier from './notifier.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load wallet config
async function getWalletConfig() {
  const configPath = path.join(__dirname, '../../config/wallets.json');
  const data = await fs.readFile(configPath, 'utf-8');
  return JSON.parse(data);
}

// Trade log
const TRADES_LOG = path.join(__dirname, '../../data/trades.json');

async function loadTrades() {
  try {
    const data = await fs.readFile(TRADES_LOG, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveTrade(trade) {
  const trades = await loadTrades();
  trades.push(trade);
  await fs.mkdir(path.dirname(TRADES_LOG), { recursive: true });
  await fs.writeFile(TRADES_LOG, JSON.stringify(trades, null, 2));
  return trade;
}

async function updateTrade(tradeId, updates) {
  const trades = await loadTrades();
  const index = trades.findIndex(t => t.id === tradeId);
  if (index >= 0) {
    trades[index] = { ...trades[index], ...updates };
    await fs.writeFile(TRADES_LOG, JSON.stringify(trades, null, 2));
  }
}

/**
 * Execute a Solana swap using native wallet (Jupiter)
 * Includes retry logic with fresh quotes for slippage failures
 */
async function executeSwapNativeSolana(swapData, retryContext = null) {
  const MAX_RETRIES = 3;
  const attempt = retryContext?.attempt || 1;
  
  console.log(`   🔐 Signing with native Solana wallet... (attempt ${attempt}/${MAX_RETRIES})`);
  
  // swapData.swapTransaction is base64-encoded from Jupiter
  const result = await solanaWallet.signAndSendRawTransaction(
    swapData.swapTransaction,
    { skipPreflight: true, maxRetries: 2 }  // skipPreflight to avoid simulation errors
  );
  
  if (!result.success) {
    const isSlippageError = result.error?.includes('0x1788') || 
                           result.error?.includes('Slippage') ||
                           result.error?.includes('ExceededSlippage');
    
    // Retry with fresh quote on slippage errors
    if (isSlippageError && attempt < MAX_RETRIES && retryContext?.refreshQuote) {
      console.log(`   ⚠️ Slippage error, retrying with fresh quote...`);
      await new Promise(r => setTimeout(r, 1000)); // Brief delay
      
      try {
        const freshSwapData = await retryContext.refreshQuote();
        return executeSwapNativeSolana(freshSwapData, { ...retryContext, attempt: attempt + 1 });
      } catch (refreshErr) {
        console.error(`   ❌ Failed to refresh quote: ${refreshErr.message}`);
      }
    }
    
    // Don't throw - return failure gracefully
    console.error(`   ❌ Swap failed after ${attempt} attempts: ${result.error}`);
    return { success: false, error: result.error, chain: 'solana' };
  }
  
  return { success: true, txHash: result.signature, chain: 'solana' };
}

/**
 * Execute a swap via Venly (EVM chains only now)
 * Solana uses native wallet
 */
async function executeSwapViaVenly(chain, walletId, swapData, pin, retryContext = null) {
  // Route Solana to native wallet
  if (chain === 'solana') {
    return executeSwapNativeSolana(swapData, retryContext);
  }
  
  const token = await venly.getToken();
  
  // EVM chains only below
    // For EVM chains, execute raw transaction
    const secretType = chain.toUpperCase() === 'POLYGON' ? 'MATIC' : chain.toUpperCase();
    
    const response = await fetch('https://api-wallet.venly.io/api/transactions/execute', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pincode: pin,
        transactionRequest: {
          type: `${secretType}_TRANSACTION`,
          walletId: walletId,
          to: swapData.tx.to,
          value: swapData.tx.value || '0',
          data: swapData.tx.data,
          ...(swapData.tx.gas && { gas: swapData.tx.gas.toString() })
        }
      })
    });

    const result = await response.json();
    if (!result.success) {
      throw new Error(`Venly execution failed: ${JSON.stringify(result)}`);
    }

    return { txHash: result.result.transactionHash, chain };
}

/**
 * Handle token approval if needed
 */
async function ensureApproval(chain, tokenAddress, walletAddress, walletId, amount, pin) {
  // Check if approval is needed
  const { needsApproval } = await dex.checkAllowance(chain, tokenAddress, walletAddress);
  
  if (!needsApproval) {
    console.log('   ✓ Token already approved');
    return true;
  }

  console.log('   🔐 Approving token for 1inch router...');
  
  // Build approval transaction
  const approvalTx = await dex.buildApproval(chain, tokenAddress);
  
  // Execute approval
  const token = await venly.getToken();
  const secretType = chain.toUpperCase() === 'POLYGON' ? 'MATIC' : chain.toUpperCase();
  
  const response = await fetch('https://api-wallet.venly.io/api/transactions/execute', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      pincode: pin,
      transactionRequest: {
        type: `${secretType}_TRANSACTION`,
        walletId: walletId,
        to: approvalTx.to,
        value: '0',
        data: approvalTx.data,
        gas: '60000'
      }
    })
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Approval failed: ${JSON.stringify(result)}`);
  }

  console.log(`   ✓ Approved: ${result.result.transactionHash}`);
  
  // Wait for confirmation
  await new Promise(r => setTimeout(r, 5000));
  
  return true;
}

/**
 * Execute a BUY order (native token -> target token)
 */
export async function executeBuy(signal, options = {}) {
  const { chain, tokenAddress, tokenSymbol, size, stopLoss = 2, takeProfit = 10 } = signal;
  const pin = options.pin || process.env.WALLET_PIN;
  
  console.log(`\n🔄 Executing BUY: ${tokenSymbol} on ${chain}`);
  console.log(`   Size: $${size.toFixed(2)}`);
  console.log(`   Stop Loss: ${stopLoss}%`);
  console.log(`   Take Profit: ${takeProfit}%`);
  
  // Load wallet config
  const walletConfig = await getWalletConfig();
  const wallet = walletConfig.wallets[chain];
  
  if (!wallet) {
    throw new Error(`No wallet configured for ${chain}`);
  }

  // Check risk approval
  const riskCheck = risk.canTrade({
    token: tokenSymbol,
    size: size,
    stopLoss: stopLoss
  });
  
  if (!riskCheck.approved) {
    console.log(`   ❌ Risk rejected: ${riskCheck.reason}`);
    await notifier.riskAlert(`Trade rejected: ${riskCheck.reason}`);
    return { success: false, reason: riskCheck.reason };
  }

  // Get native token price to calculate amount
  const prices = await oracle.getPrices();
  const nativePrice = chain === 'solana' ? prices.SOL : prices.ETH;
  const nativeAmount = size / nativePrice;
  const nativeDecimals = chain === 'solana' ? 9 : 18;
  const rawAmount = dex.parseAmount(nativeAmount.toFixed(nativeDecimals), nativeDecimals);

  console.log(`   Native Amount: ${nativeAmount.toFixed(6)} ${chain === 'solana' ? 'SOL' : 'ETH'}`);

  // Determine token addresses
  const tokenIn = dex.TOKENS[chain]?.NATIVE || dex.NATIVE_TOKEN;
  const tokenOut = tokenAddress;

  // Create trade record
  const trade = {
    id: `trade_${Date.now()}`,
    type: 'BUY',
    chain,
    token: tokenSymbol,
    tokenAddress,
    size,
    nativeAmount,
    stopLoss,
    takeProfit,
    status: 'BUILDING',
    signal,
    createdAt: new Date().toISOString()
  };

  await saveTrade(trade);

  try {
    // Get quote first
    console.log('   📊 Getting quote...');
    const quote = await dex.getQuote(chain, tokenIn, tokenOut, rawAmount);
    console.log(`   Expected output: ${dex.formatAmount(quote.amountOut, 18)} tokens`);

    // Build swap transaction
    console.log('   🔨 Building swap...');
    const swapData = await dex.buildSwap(
      chain, 
      tokenIn, 
      tokenOut, 
      rawAmount, 
      wallet.address,
      5 // 5% slippage for volatile memecoins
    );

    // Update trade with expected values
    trade.expectedTokens = quote.amountOut;
    trade.status = 'EXECUTING';
    await updateTrade(trade.id, trade);

    // Create retry context with fresh quote function (for Solana slippage retries)
    const retryContext = chain === 'solana' ? {
      refreshQuote: async () => {
        console.log('   🔄 Fetching fresh quote...');
        return dex.buildSwap(chain, tokenIn, tokenOut, rawAmount, wallet.address, 5);
      }
    } : null;

    // Execute via Venly
    console.log('   ⚡ Executing swap...');
    const result = await executeSwapViaVenly(chain, wallet.id, swapData, pin, retryContext);
    
    // Handle swap failure gracefully
    if (result.success === false) {
      trade.status = 'FAILED';
      trade.error = result.error;
      await updateTrade(trade.id, trade);
      console.log(`   ❌ Swap failed: ${result.error}`);
      return { success: false, reason: result.error };
    }
    
    // Get current price for entry tracking
    const currentPrice = await getCurrentTokenPrice(tokenAddress);

    // Update trade record
    trade.status = 'COMPLETED';
    trade.txHash = result.txHash;
    trade.entryPrice = currentPrice;
    trade.stopPrice = currentPrice * (1 - stopLoss / 100);
    trade.takeProfitPrice = currentPrice * (1 + takeProfit / 100);
    trade.completedAt = new Date().toISOString();
    
    await updateTrade(trade.id, trade);

    // Add to risk manager
    risk.addPosition({
      id: trade.id,
      chain,
      token: tokenSymbol,
      tokenAddress,
      entryPrice: currentPrice,
      size,
      stopLoss,
      takeProfit
    });

    console.log(`   ✅ Trade executed: ${result.txHash}`);

    // Notify
    await notifier.tradeExecuted({
      action: 'BUY',
      chain,
      token: tokenSymbol,
      price: currentPrice,
      size,
      txHash: result.txHash
    });

    return { 
      success: true, 
      trade,
      txHash: result.txHash,
      message: `Bought ${tokenSymbol} for $${size.toFixed(2)}`
    };

  } catch (error) {
    console.log(`   ❌ Execution failed: ${error.message}`);
    
    trade.status = 'FAILED';
    trade.error = error.message;
    await updateTrade(trade.id, trade);

    await notifier.error(`Trade failed: ${error.message}`);
    
    return { success: false, reason: error.message, trade };
  }
}

/**
 * Execute a SELL order (token -> native)
 */
export async function executeSell(position, reason = 'MANUAL', options = {}) {
  const { chain, tokenAddress, token: tokenSymbol, size } = position;
  const pin = options.pin || process.env.WALLET_PIN;
  
  console.log(`\n🔄 Executing SELL: ${tokenSymbol} on ${chain}`);
  console.log(`   Position size: $${size}`);
  console.log(`   Reason: ${reason}`);

  const walletConfig = await getWalletConfig();
  const wallet = walletConfig.wallets[chain];
  
  if (!wallet) {
    throw new Error(`No wallet configured for ${chain}`);
  }

  // Get current token balance
  const balances = await venly.getBalance(wallet.id);
  // Find the token balance - this depends on how Venly returns it
  // For now we'll estimate based on entry
  
  // Get current price
  const currentPrice = await getCurrentTokenPrice(tokenAddress);
  const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const pnlUsd = size * (pnlPct / 100);

  console.log(`   Entry: $${position.entryPrice?.toFixed(6) || 'unknown'}`);
  console.log(`   Current: $${currentPrice.toFixed(6)}`);
  console.log(`   P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`);

  const trade = {
    id: `trade_${Date.now()}`,
    type: 'SELL',
    chain,
    token: tokenSymbol,
    tokenAddress,
    entryPrice: position.entryPrice,
    exitPrice: currentPrice,
    size,
    pnlPct,
    pnlUsd,
    reason,
    status: 'BUILDING',
    createdAt: new Date().toISOString()
  };

  await saveTrade(trade);

  try {
    // Token addresses
    const tokenIn = tokenAddress;
    const tokenOut = dex.TOKENS[chain]?.NATIVE || dex.NATIVE_TOKEN;

    // Estimate token amount from position
    // In production, query actual balance from chain
    const estimatedTokens = (size / position.entryPrice).toString();
    const rawAmount = dex.parseAmount(estimatedTokens, 18);

    // Check and handle approval
    if (chain !== 'solana') {
      await ensureApproval(chain, tokenIn, wallet.address, wallet.id, rawAmount, pin);
    }

    // Build swap
    console.log('   🔨 Building sell swap...');
    const swapData = await dex.buildSwap(
      chain,
      tokenIn,
      tokenOut,
      rawAmount,
      wallet.address,
      10 // 10% slippage for sells (memecoins are volatile!)
    );

    trade.status = 'EXECUTING';
    await updateTrade(trade.id, trade);

    // Create retry context for Solana slippage retries
    const retryContext = chain === 'solana' ? {
      refreshQuote: async () => {
        console.log('   🔄 Fetching fresh quote for sell...');
        return dex.buildSwap(chain, tokenIn, tokenOut, rawAmount, wallet.address, 10);
      }
    } : null;

    // Execute
    console.log('   ⚡ Executing swap...');
    const result = await executeSwapViaVenly(chain, wallet.id, swapData, pin, retryContext);

    // Handle swap failure gracefully
    if (result.success === false) {
      trade.status = 'FAILED';
      trade.error = result.error;
      await updateTrade(trade.id, trade);
      console.log(`   ❌ Sell failed: ${result.error}`);
      return { success: false, reason: result.error, pnlPct };
    }

    // Update trade
    trade.status = 'COMPLETED';
    trade.txHash = result.txHash;
    trade.completedAt = new Date().toISOString();
    
    await updateTrade(trade.id, trade);

    // Close position in risk manager
    risk.closePosition(position.id, currentPrice, pnlPct);

    console.log(`   ✅ Sold: ${result.txHash}`);

    // Notify based on outcome
    if (pnlPct >= 0) {
      await notifier.profitLocked({
        chain,
        token: tokenSymbol,
        pnl: pnlPct,
        pnlUsd,
        reason,
        txHash: result.txHash
      });
    } else {
      await notifier.lossRealized({
        chain,
        token: tokenSymbol,
        pnl: pnlPct,
        pnlUsd,
        reason,
        txHash: result.txHash
      });
    }

    return { success: true, trade, txHash: result.txHash };

  } catch (error) {
    console.log(`   ❌ Sell failed: ${error.message}`);
    
    trade.status = 'FAILED';
    trade.error = error.message;
    await updateTrade(trade.id, trade);

    await notifier.error(`Sell failed for ${tokenSymbol}: ${error.message}`);
    
    return { success: false, reason: error.message, trade };
  }
}

/**
 * Get current token price from DEX Screener
 */
async function getCurrentTokenPrice(tokenAddress) {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { timeout: 5000 }
    );
    const data = await response.json();
    const pair = data.pairs?.[0];
    
    if (pair) {
      return parseFloat(pair.priceUsd);
    }
  } catch (e) {
    console.log(`   ⚠️ Price fetch failed: ${e.message}`);
  }
  
  return 0;
}

/**
 * Monitor positions and trigger stop-loss / take-profit
 */
export async function checkPositions(options = {}) {
  const state = risk.getState();
  const positions = state.openPositions;
  
  if (positions.length === 0) {
    return { checked: 0, triggered: 0 };
  }
  
  console.log(`\n👁️ Checking ${positions.length} positions...`);
  
  let triggered = 0;
  
  for (const position of positions) {
    try {
      const currentPrice = await getCurrentTokenPrice(position.tokenAddress);
      
      if (currentPrice === 0) {
        console.log(`   ⚠️ No price for ${position.token}`);
        continue;
      }
      
      const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      console.log(`   ${position.token}: $${currentPrice.toFixed(6)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);
      
      // Check stop loss
      if (pnlPct <= -position.stopLoss) {
        console.log(`   🛑 STOP LOSS triggered!`);
        await executeSell(position, 'STOP_LOSS', options);
        triggered++;
        continue;
      }
      
      // Check take profit
      if (pnlPct >= position.takeProfit) {
        console.log(`   💰 TAKE PROFIT triggered!`);
        await executeSell(position, 'TAKE_PROFIT', options);
        triggered++;
        continue;
      }
      
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
    }
  }
  
  return { checked: positions.length, triggered };
}

/**
 * Get a swap quote (no execution)
 */
export async function getQuote(chain, tokenIn, tokenOut, amount) {
  return dex.getQuote(chain, tokenIn, tokenOut, amount);
}

/**
 * Get all trades history
 */
export async function getTrades(filter = {}) {
  const trades = await loadTrades();
  
  if (filter.status) {
    return trades.filter(t => t.status === filter.status);
  }
  if (filter.chain) {
    return trades.filter(t => t.chain === filter.chain);
  }
  if (filter.type) {
    return trades.filter(t => t.type === filter.type);
  }
  
  return trades;
}

export default {
  executeBuy,
  executeSell,
  checkPositions,
  getQuote,
  getTrades,
  loadTrades
};
