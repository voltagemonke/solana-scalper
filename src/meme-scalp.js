#!/usr/bin/env node
/**
 * SOLANA SCALPER 👑
 * 
 * Lightning-fast meme coin trading on Solana
 * - 15 second scans
 * - Dynamic slippage
 * - Quick scalp exits
 */

import 'dotenv/config';
import memeScalp, { recordTokenLoss, getCooldownStats } from './strategies/meme-scalp.js';
import solanaWallet from './core/solana-wallet.js';
import dex from './core/dex.js';
import notifier from './core/notifier.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../data/scalper-session.json');

// Configuration
const CONFIG = {
  paperMode: process.env.MEME_PAPER_MODE !== 'false',
  positionSizePct: memeScalp.CONFIG.positionSizePct,
  maxPositions: memeScalp.CONFIG.maxPositions,
  scanIntervalMs: memeScalp.CONFIG.scanIntervalMs,
  
  // ⚠️ SLIPPAGE SIMULATION - Make paper trading realistic!
  // Entry slippage: price is worse than displayed (you buy higher)
  // Exit slippage: price is worse than displayed (you sell lower)
  simulatedEntrySlippage: 0.03,  // 3% worse entry
  simulatedExitSlippage: 0.02,   // 2% worse exit  
  // Total round-trip cost: ~5% in slippage
};

// State
const state = {
  positions: [],
  closedTrades: [],
  startTime: Date.now(),
  scans: 0,
  paperBalance: 100, // Paper mode starting balance
};

// Blacklist (scam tokens, honeypots)
const BLACKLIST = new Set([
  'SOL', 'USDC', 'USDT', // Don't trade these as memes
]);

// Cooldown tracking - don't re-enter same token too soon
const recentExits = new Map(); // tokenAddress -> exitTime
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minute cooldown after exit

async function loadState() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    const saved = JSON.parse(data);
    state.positions = saved.positions || [];
    state.closedTrades = saved.closedTrades || [];
    state.paperBalance = saved.paperBalance || 100;
    console.log(`[State] Loaded ${state.positions.length} positions`);
  } catch {
    console.log('[State] Starting fresh');
  }
}

async function saveState() {
  await fs.writeFile(DATA_FILE, JSON.stringify({
    positions: state.positions,
    closedTrades: state.closedTrades,
    paperBalance: state.paperBalance,
    lastUpdate: Date.now(),
  }, null, 2));
}

async function notify(msg) {
  console.log(msg);
  try {
    await notifier.send(msg);
  } catch {}
}

async function getBalance() {
  if (CONFIG.paperMode) return state.paperBalance;
  const wallet = await solanaWallet.verify();
  return wallet.sol * 100; // Rough USD estimate
}

async function executeBuy(opp) {
  const balance = await getBalance();
  const positionSize = balance * (CONFIG.positionSizePct / 100);
  
  if (positionSize < 1) {
    console.log('   Position too small, skipping');
    return null;
  }
  
  const slippage = memeScalp.getSlippage(opp.liquidity);
  
  console.log(`\n🚀 MEME BUY: ${opp.token}`);
  console.log(`   Price: $${opp.price.toFixed(8)}`);
  console.log(`   Size: $${positionSize.toFixed(2)}`);
  console.log(`   Slippage: ${slippage}%`);
  console.log(`   Score: ${opp.score}`);
  
  if (CONFIG.paperMode) {
    // Paper trade - SIMULATE SLIPPAGE for realistic results!
    // Entry price is WORSE (higher) due to slippage
    const slippageAdjustedEntry = opp.price * (1 + CONFIG.simulatedEntrySlippage);
    
    const position = {
      id: `meme_${Date.now()}`,
      token: opp.token,
      tokenAddress: opp.tokenAddress,
      entryPrice: slippageAdjustedEntry,  // ⚠️ Simulated slippage applied!
      displayPrice: opp.price,             // Original price for reference
      entryTime: Date.now(),
      size: positionSize,
      score: opp.score,
      slippage: slippage,
      peakPrice: slippageAdjustedEntry,
      simulatedSlippage: CONFIG.simulatedEntrySlippage,
    };
    
    console.log(`   📊 Simulated entry slippage: ${(CONFIG.simulatedEntrySlippage * 100).toFixed(1)}% ($${opp.price.toFixed(8)} → $${slippageAdjustedEntry.toFixed(8)})`);
    
    state.positions.push(position);
    state.paperBalance -= positionSize;
    await saveState();
    
    await notify(`🚀 MEME SCALP BUY\n\n${opp.token}\n💰 $${positionSize.toFixed(2)} @ $${opp.price.toFixed(8)}\n📊 Score: ${opp.score}\n🎯 TP: +${memeScalp.CONFIG.takeProfitPct}% | SL: -${memeScalp.CONFIG.stopLossPct}%`);
    
    return position;
  } else {
    // Real trade
    try {
      const solAmount = positionSize / 100; // Convert to SOL (rough)
      const result = await dex.swap({
        chain: 'solana',
        inputToken: 'So11111111111111111111111111111111111111112', // SOL
        outputToken: opp.tokenAddress,
        amount: solAmount,
        slippageBps: slippage * 100,
      });
      
      if (result.success) {
        const position = {
          id: `meme_${Date.now()}`,
          token: opp.token,
          tokenAddress: opp.tokenAddress,
          entryPrice: opp.price,
          entryTime: Date.now(),
          size: positionSize,
          score: opp.score,
          txHash: result.txHash,
          peakPrice: opp.price,
        };
        
        state.positions.push(position);
        await saveState();
        
        await notify(`🚀 MEME SCALP BUY (LIVE)\n\n${opp.token}\n💰 $${positionSize.toFixed(2)}\n🔗 TX: ${result.txHash?.slice(0, 20)}...`);
        
        return position;
      }
    } catch (e) {
      console.error('   Buy failed:', e.message);
    }
  }
  
  return null;
}

async function executeSell(position, reason, currentPrice) {
  // ⚠️ SIMULATE EXIT SLIPPAGE - sell price is worse (lower) than displayed
  const slippageAdjustedExit = CONFIG.paperMode 
    ? currentPrice * (1 - CONFIG.simulatedExitSlippage)
    : currentPrice;
  
  const pnlPct = ((slippageAdjustedExit - position.entryPrice) / position.entryPrice) * 100;
  const pnlUsd = position.size * (pnlPct / 100);
  
  console.log(`\n💰 MEME SELL: ${position.token}`);
  console.log(`   Reason: ${reason}`);
  if (CONFIG.paperMode) {
    console.log(`   📊 Simulated exit slippage: ${(CONFIG.simulatedExitSlippage * 100).toFixed(1)}% ($${currentPrice.toFixed(8)} → $${slippageAdjustedExit.toFixed(8)})`);
  }
  console.log(`   P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`);
  
  if (CONFIG.paperMode) {
    state.paperBalance += position.size + pnlUsd;
    
    const closedTrade = {
      ...position,
      exitPrice: slippageAdjustedExit,     // ⚠️ Slippage-adjusted exit
      displayExitPrice: currentPrice,       // Original price for reference
      exitTime: Date.now(),
      pnlPct,
      pnlUsd,
      reason,
      totalSimulatedSlippage: CONFIG.simulatedEntrySlippage + CONFIG.simulatedExitSlippage,
    };
    
    state.closedTrades.push(closedTrade);
    state.positions = state.positions.filter(p => p.id !== position.id);
    
    // Add to cooldown - don't re-enter this token for 30 min
    recentExits.set(position.tokenAddress, Date.now());
    console.log(`   ⏳ ${position.token} on 30min cooldown`);
    
    // V2: Record loss for extended cooldown tracking
    if (pnlPct < 0) {
      recordTokenLoss(position.tokenAddress);
    }
    
    await saveState();
    
    const emoji = pnlPct >= 0 ? '✅' : '❌';
    await notify(`${emoji} MEME SCALP EXIT\n\n${position.token}\n📊 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)})\n📝 ${reason}\n\n💰 Balance: $${state.paperBalance.toFixed(2)}`);
  } else {
    // Real sell
    try {
      const result = await dex.swap({
        chain: 'solana',
        inputToken: position.tokenAddress,
        outputToken: 'So11111111111111111111111111111111111111112', // SOL
        amount: 'all', // Sell all
        slippageBps: memeScalp.getSlippage(50000) * 100, // Use medium slippage for exit
      });
      
      if (result.success) {
        const closedTrade = {
          ...position,
          exitPrice: currentPrice,
          exitTime: Date.now(),
          pnlPct,
          pnlUsd,
          reason,
          exitTxHash: result.txHash,
        };
        
        state.closedTrades.push(closedTrade);
        state.positions = state.positions.filter(p => p.id !== position.id);
        await saveState();
        
        await notify(`💰 MEME SCALP EXIT (LIVE)\n\n${position.token}\n📊 ${pnlPct.toFixed(2)}%\n🔗 TX: ${result.txHash?.slice(0, 20)}...`);
      }
    } catch (e) {
      console.error('   Sell failed:', e.message);
    }
  }
}

async function checkPositions() {
  for (const position of state.positions) {
    try {
      // Get current price
      const resp = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${position.tokenAddress}`
      );
      const data = await resp.json();
      const pair = data.pairs?.[0];
      
      if (!pair) continue;
      
      const currentPrice = parseFloat(pair.priceUsd || 0);
      if (currentPrice <= 0) continue;
      
      // Check exit conditions
      const exitCheck = memeScalp.checkExit(position, currentPrice);
      
      // Update peak price
      if (exitCheck.newPeak) {
        position.peakPrice = exitCheck.newPeak;
      }
      
      const pnl = exitCheck.pnlPct;
      console.log(`   ${position.token}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
      
      if (exitCheck.shouldExit) {
        await executeSell(position, exitCheck.reason, currentPrice);
      }
    } catch (e) {
      console.error(`   Error checking ${position.token}:`, e.message);
    }
  }
}

async function scanAndTrade() {
  state.scans++;
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Meme Scan #${state.scans}`);
  
  // Check existing positions first
  if (state.positions.length > 0) {
    console.log(`   Checking ${state.positions.length} positions...`);
    await checkPositions();
  }
  
  // Look for new opportunities
  if (state.positions.length < CONFIG.maxPositions) {
    console.log('   🔍 Scanning for meme opportunities...');
    const opportunities = await memeScalp.scan();
    
    if (opportunities.length > 0) {
      console.log(`   Found ${opportunities.length} opportunities`);
      
      for (const opp of opportunities) {
        // Skip if already in position
        if (state.positions.some(p => p.tokenAddress === opp.tokenAddress)) {
          continue;
        }
        
        // Skip blacklisted
        if (BLACKLIST.has(opp.token)) {
          continue;
        }
        
        // Skip if on cooldown (recently exited)
        const lastExit = recentExits.get(opp.tokenAddress);
        if (lastExit && Date.now() - lastExit < COOLDOWN_MS) {
          const minsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastExit)) / 60000);
          console.log(`   ⏳ ${opp.token} on cooldown (${minsLeft}min left)`);
          continue;
        }
        
        // Skip if max positions
        if (state.positions.length >= CONFIG.maxPositions) {
          break;
        }
        
        console.log(`\n   🎯 Best: ${opp.token} - Score ${opp.score}${opp.isTrending ? ' 🔥' : ''}`);
        console.log(`      5m: ${opp.priceChange5m >= 0 ? '+' : ''}${opp.priceChange5m.toFixed(1)}% | Liq: $${(opp.liquidity/1000).toFixed(1)}k`);
        
        await executeBuy(opp);
        break; // One buy per scan
      }
    } else {
      console.log('   No opportunities found');
    }
  } else {
    console.log('   Max positions reached');
  }
}

async function main() {
  console.log('\n' + '🚀'.repeat(30));
  console.log('  SOLANA SCALPER 👑');
  console.log('  ' + (CONFIG.paperMode ? '📝 PAPER MODE' : '🟢 LIVE MODE'));
  console.log('🚀'.repeat(30));
  
  await loadState();
  
  const stats = memeScalp.getStats();
  console.log('\n⚡ Strategy:', stats.strategy);
  console.log(`📊 Scan Interval: ${stats.scanInterval}`);
  console.log(`🎯 Take Profit: ${stats.takeProfit}`);
  console.log(`🛑 Stop Loss: ${stats.stopLoss}`);
  console.log(`📈 Trailing: ${stats.trailingStart}`);
  console.log(`⏱️ Max Hold: ${stats.maxHold}`);
  console.log(`💰 Position Size: ${stats.positionSize}`);
  
  const balance = await getBalance();
  console.log(`\n💵 Balance: $${balance.toFixed(2)}`);
  console.log(`📍 Positions: ${state.positions.length}/${CONFIG.maxPositions}`);
  
  await notify(`🚀 MEME SCALPER STARTED\n\n${CONFIG.paperMode ? '📝 Paper Mode' : '🟢 LIVE'}\n💵 Balance: $${balance.toFixed(2)}\n\n⚡ ${stats.scanInterval} scans\n🎯 TP: ${stats.takeProfit}\n🛑 SL: ${stats.stopLoss}`);
  
  // Initial scan
  await scanAndTrade();
  
  // Fast scan loop
  setInterval(scanAndTrade, CONFIG.scanIntervalMs);
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down Meme Scalper...');
    await saveState();
    
    const wins = state.closedTrades.filter(t => t.pnlPct > 0).length;
    const losses = state.closedTrades.filter(t => t.pnlPct <= 0).length;
    const totalPnl = state.closedTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    
    await notify(`🛑 MEME SCALPER STOPPED\n\n📊 Trades: ${state.closedTrades.length}\n✅ Wins: ${wins}\n❌ Losses: ${losses}\n💰 P&L: $${totalPnl.toFixed(2)}`);
    
    process.exit(0);
  });
}

main().catch(console.error);
