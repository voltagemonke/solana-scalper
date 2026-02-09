/**
 * MEME SCALP STRATEGY 👑
 * 
 * Optimized for quick meme coin pumps on Solana
 * - Fast 15s scans
 * - Dynamic slippage based on liquidity
 * - Quick entries/exits
 * - Focus on fresh pumping tokens
 */

import fetch from 'node-fetch';

const DEXSCREENER_API = 'https://api.dexscreener.com';

// Token cooldown tracking - prevents repeating mistakes on same token
const tokenLossMemory = new Map(); // tokenAddress -> { losses: number, lastLossTime: timestamp }

/**
 * Check if token is on cooldown after losses
 */
export function isTokenOnCooldown(tokenAddress) {
  const memory = tokenLossMemory.get(tokenAddress);
  if (!memory) return false;
  
  const now = Date.now();
  const cooldownMs = memory.losses >= CONFIG.maxLossesPerToken 
    ? CONFIG.extendedCooldownMs 
    : CONFIG.tokenCooldownMs;
  
  const cooldownEnds = memory.lastLossTime + cooldownMs;
  
  if (now < cooldownEnds) {
    const minsLeft = Math.round((cooldownEnds - now) / 60000);
    console.log(`   ⏳ ${tokenAddress.slice(0,8)}... on cooldown (${minsLeft}min left, ${memory.losses} losses)`);
    return true;
  }
  
  // Cooldown expired, clear memory
  tokenLossMemory.delete(tokenAddress);
  return false;
}

/**
 * Record a loss on a token (call after losing trade)
 */
export function recordTokenLoss(tokenAddress) {
  const memory = tokenLossMemory.get(tokenAddress) || { losses: 0, lastLossTime: 0 };
  memory.losses += 1;
  memory.lastLossTime = Date.now();
  tokenLossMemory.set(tokenAddress, memory);
  console.log(`   📝 Recorded loss #${memory.losses} for ${tokenAddress.slice(0,8)}...`);
}

/**
 * Get cooldown stats for logging
 */
export function getCooldownStats() {
  return {
    tokensOnCooldown: tokenLossMemory.size,
    tokens: Array.from(tokenLossMemory.entries()).map(([addr, mem]) => ({
      token: addr.slice(0, 8),
      losses: mem.losses,
      minsAgo: Math.round((Date.now() - mem.lastLossTime) / 60000),
    })),
  };
}

// Meme Scalp Configuration - V5 HIGH WIN RATE (2026-02-09)
// Multiple confirmations = higher win rate
export const CONFIG = {
  // Scanning
  scanIntervalMs: 15000,        // 15 second scans (FAST)
  
  // Entry Criteria - V5 STRICT CONFIRMATIONS
  minLiquidityUsd: 20000,       // Min $20k liquidity (catch earlier)
  maxLiquidityUsd: 2000000,     // Max $2M
  minVolume24h: 50000,          // Min $50k daily volume
  minVolumeSpike: 2.0,          // V5: 2x volume spike REQUIRED (realistic)
  maxTokenAgeHours: 24,         // V5: Fresh tokens only (was 48h)
  minPriceChange5m: 1.5,        // V5: 1.5% move required (balanced)
  maxPriceChange5m: 50,         // Cap at 50% (avoid FOMO entries)
  minBuyRatio: 0.52,            // V5: 52% buyers required (balanced)
  minScore: 50,                 // Keep score flexible
  
  // Token Cooldown - PREVENTS REPEATING MISTAKES
  tokenCooldownMs: 60 * 60 * 1000,   // 1 hour cooldown after losing trade
  maxLossesPerToken: 2,              // After 2 losses, 4 hour cooldown
  extendedCooldownMs: 4 * 60 * 60 * 1000, // 4 hour extended cooldown
  
  // Risk Management
  positionSizePct: 4,           // 4% per meme trade (smaller)
  maxPositions: 3,              // Max 3 meme positions
  
  // Exit Strategy (V5 - FAST profit taking)
  takeProfitPct: 6,             // V5: Take 6% profit FAST (was 12%)
  stopLossPct: 5,               // V5: Tighter stop -5% (was 8%)
  trailingActivatePct: 4,       // V5: Start trailing at +4%
  trailingDistancePct: 2,       // V5: Trail 2% behind peak (tighter)
  maxHoldTimeMs: 2 * 60 * 1000, // V5: Max 2 min hold (was 5)
  
  // Honeypot Detection (V4)
  minSellsRequired: 3,          // Token must have at least 3 sells in 24h
  minSellRatio: 0.15,           // At least 15% of txns must be sells (not just buys)
  
  // Slippage (Dynamic)
  slippageRules: [
    { maxLiquidity: 50000, slippage: 5 },    // Low liq = 5%
    { maxLiquidity: 100000, slippage: 3.5 }, // Medium = 3.5%
    { maxLiquidity: 200000, slippage: 2.5 }, // Good = 2.5%
    { maxLiquidity: Infinity, slippage: 2 }, // High = 2%
  ],
};

/**
 * Calculate dynamic slippage based on liquidity
 */
export function getSlippage(liquidityUsd) {
  for (const rule of CONFIG.slippageRules) {
    if (liquidityUsd <= rule.maxLiquidity) {
      return rule.slippage;
    }
  }
  return 2; // Default
}

// Jupiter API for real slippage quotes
const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * 🧠 SMART PRE-FLIGHT CHECK: Get REAL buy + sell slippage before trading!
 * Returns the full round-trip cost so we know the odds BEFORE entering.
 */
export async function getRealSlippageCost(tokenAddress, amountUsd = 10) {
  try {
    const amountLamports = Math.floor(amountUsd * 10000000); // ~$10 in lamports at $100/SOL
    
    // 1. Get BUY quote (SOL → Token) with auto-slippage
    const buyQuoteUrl = `${JUPITER_API}/quote?inputMint=${SOL_MINT}&outputMint=${tokenAddress}&amount=${amountLamports}&slippageBps=500&autoSlippage=true&maxAutoSlippageBps=1000`;
    const buyResp = await fetch(buyQuoteUrl, { timeout: 5000 });
    const buyQuote = await buyResp.json();
    
    if (buyQuote.error) {
      console.log(`   ⚠️ No buy route for token`);
      return { success: false, reason: 'No buy route' };
    }
    
    const buyPriceImpact = parseFloat(buyQuote.priceImpactPct || 0);
    const tokensReceived = buyQuote.outAmount;
    
    // 2. Get SELL quote (Token → SOL) - simulate selling what we'd receive
    const sellQuoteUrl = `${JUPITER_API}/quote?inputMint=${tokenAddress}&outputMint=${SOL_MINT}&amount=${tokensReceived}&slippageBps=500&autoSlippage=true&maxAutoSlippageBps=1000`;
    const sellResp = await fetch(sellQuoteUrl, { timeout: 5000 });
    const sellQuote = await sellResp.json();
    
    if (sellQuote.error) {
      console.log(`   ⚠️ No sell route for token (HONEYPOT RISK!)`);
      return { success: false, reason: 'No sell route - possible honeypot!' };
    }
    
    const sellPriceImpact = parseFloat(sellQuote.priceImpactPct || 0);
    
    // 3. Calculate total round-trip cost
    const totalSlippage = Math.abs(buyPriceImpact) + Math.abs(sellPriceImpact);
    
    return {
      success: true,
      buySlippage: buyPriceImpact,
      sellSlippage: sellPriceImpact,
      totalRoundTrip: totalSlippage,
      tokensForAmount: tokensReceived,
    };
    
  } catch (e) {
    console.log(`   ⚠️ Slippage check failed: ${e.message}`);
    return { success: false, reason: e.message };
  }
}

/**
 * Get trending/boosted tokens from DexScreener
 */
async function getTrendingTokens() {
  try {
    const [boostsResp, profilesResp] = await Promise.all([
      fetch(`${DEXSCREENER_API}/token-boosts/latest/v1`),
      fetch(`${DEXSCREENER_API}/token-profiles/latest/v1`),
    ]);
    
    const boosts = await boostsResp.json();
    const profiles = await profilesResp.json();
    
    // Filter for Solana
    const solanaBoosts = (boosts || []).filter(t => t.chainId === 'solana');
    const solanaProfiles = (profiles || []).filter(t => t.chainId === 'solana');
    
    return {
      boosted: solanaBoosts.slice(0, 20),
      trending: solanaProfiles.slice(0, 20),
    };
  } catch (e) {
    console.error('[MemeScalp] Failed to get trending:', e.message);
    return { boosted: [], trending: [] };
  }
}

/**
 * Get top Solana pairs by volume (potential pumps)
 */
async function getHotPairs() {
  try {
    const resp = await fetch(`${DEXSCREENER_API}/latest/dex/tokens/solana`);
    const data = await resp.json();
    return data.pairs || [];
  } catch {
    return [];
  }
}

/**
 * Scan for meme coin opportunities
 * V3: Multiple data sources for better coverage
 */
export async function scan() {
  const opportunities = [];
  
  try {
    // Multi-source scanning for better coverage
    const searchQueries = ['pump', 'sol', 'meme', 'pepe', 'doge', 'cat', 'ai'];
    const allPairs = [];
    const seenAddresses = new Set();
    
    // Fetch from multiple search terms in parallel
    const searchPromises = searchQueries.map(async (query) => {
      try {
        const resp = await fetch(`${DEXSCREENER_API}/latest/dex/search?q=${query}`);
        const data = await resp.json();
        return (data.pairs || []).filter(p => p.chainId === 'solana');
      } catch { return []; }
    });
    
    // Also get gainers (tokens API for Solana)
    searchPromises.push((async () => {
      try {
        const resp = await fetch(`${DEXSCREENER_API}/tokens/solana`);
        const data = await resp.json();
        return data.pairs || [];
      } catch { return []; }
    })());
    
    const results = await Promise.all(searchPromises);
    
    // Dedupe and merge all pairs
    for (const pairs of results) {
      for (const pair of pairs) {
        const addr = pair.baseToken?.address;
        if (addr && !seenAddresses.has(addr)) {
          seenAddresses.add(addr);
          allPairs.push(pair);
        }
      }
    }
    
    console.log(`   📡 Found ${allPairs.length} unique tokens from ${searchQueries.length + 1} sources`);
    const pairs = allPairs;
    
    // Also get trending
    const trending = await getTrendingTokens();
    const trendingAddresses = new Set([
      ...trending.boosted.map(t => t.tokenAddress),
      ...trending.trending.map(t => t.tokenAddress),
    ]);
    
    for (const pair of pairs.slice(0, 50)) {
      const tokenAddress = pair.baseToken?.address;
      if (!tokenAddress) continue;
      
      // V2: Check token cooldown FIRST (prevents repeating mistakes)
      if (isTokenOnCooldown(tokenAddress)) {
        continue;
      }
      
      const score = scorePair(pair, trendingAddresses);
      
      // DEBUG: Log top-scoring tokens
      if (score.total >= 40) {
        const pc5m = parseFloat(pair.priceChange?.m5 || 0);
        console.log(`   🔍 ${pair.baseToken.symbol}: score ${score.total.toFixed(0)}, 5m ${pc5m > 0 ? '+' : ''}${pc5m.toFixed(1)}%`);
      }
      
      // V2: Use CONFIG.minScore (default 75) instead of hardcoded 60
      if (score.total >= CONFIG.minScore) {
        const liquidity = parseFloat(pair.liquidity?.usd || 0);
        const priceChange5m = parseFloat(pair.priceChange?.m5 || 0);
        const txns24h = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);
        const buyRatio = pair.txns?.h24?.buys / (txns24h || 1);
        
        // V2: Check minimum buy ratio (buyers must dominate)
        if (buyRatio < CONFIG.minBuyRatio) {
          // Only log first few to avoid spam
          if (opportunities.length < 3) {
            console.log(`   ⚠️ ${pair.baseToken.symbol}: buyRatio ${(buyRatio*100).toFixed(0)}% < ${CONFIG.minBuyRatio*100}% - SKIPPING`);
          }
          continue;
        }
        
        // V4: HONEYPOT DETECTION - require sells exist (not just buys)
        const sells24h = pair.txns?.h24?.sells || 0;
        const sellRatio = sells24h / (txns24h || 1);
        
        if (sells24h < CONFIG.minSellsRequired) {
          console.log(`   🍯 ${pair.baseToken.symbol}: HONEYPOT? Only ${sells24h} sells - SKIPPING`);
          continue;
        }
        
        if (sellRatio < CONFIG.minSellRatio) {
          console.log(`   🍯 ${pair.baseToken.symbol}: HONEYPOT? sellRatio ${(sellRatio*100).toFixed(0)}% too low - SKIPPING`);
          continue;
        }
        
        // V5: Check minimum 5m momentum (strict)
        if (priceChange5m < CONFIG.minPriceChange5m) {
          if (priceChange5m > 1.0) { // Log near-misses
            console.log(`   📉 ${pair.baseToken.symbol}: 5m +${priceChange5m.toFixed(1)}% < ${CONFIG.minPriceChange5m}% - SKIPPING`);
          }
          continue;
        }
        
        // V5: VOLUME SPIKE DETECTION - key indicator!
        // Compare current volume to expected (volume24h / 24 / 12 = 5min average)
        const volume5mExpected = (parseFloat(pair.volume?.h24 || 0)) / 24 / 12;
        const volume5mActual = (parseFloat(pair.volume?.h1 || 0)) / 12; // Approximate from 1h
        const volumeSpike = volume5mActual / (volume5mExpected || 1);
        
        if (volumeSpike < CONFIG.minVolumeSpike) {
          if (volumeSpike > 1.5) { // Log near-misses
            console.log(`   📊 ${pair.baseToken.symbol}: vol ${volumeSpike.toFixed(1)}x < ${CONFIG.minVolumeSpike}x - SKIPPING`);
          }
          continue;
        }
        
        // 🎯 FOUND A CANDIDATE WITH MULTIPLE CONFIRMATIONS!
        console.log(`   ✨ ${pair.baseToken.symbol}: score ${score.total}, buyRatio ${(buyRatio*100).toFixed(0)}%, 5m +${priceChange5m.toFixed(1)}%, vol ${volumeSpike.toFixed(1)}x`);
        
        opportunities.push({
          token: pair.baseToken.symbol,
          tokenAddress: tokenAddress,
          name: pair.baseToken.name,
          chain: 'solana',
          price: parseFloat(pair.priceUsd || 0),
          liquidity: liquidity,
          volume24h: parseFloat(pair.volume?.h24 || 0),
          priceChange5m: priceChange5m,
          priceChange1h: parseFloat(pair.priceChange?.h1 || 0),
          priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
          buyRatio: buyRatio,
          pairAddress: pair.pairAddress,
          dexId: pair.dexId,
          score: score.total,
          scoreBreakdown: score,
          slippage: getSlippage(liquidity),
          isTrending: trendingAddresses.has(tokenAddress),
          strategy: 'meme-scalp',
        });
      }
    }
    
    // Sort by score
    opportunities.sort((a, b) => b.score - a.score);
    
    // 🧠 SMART PRE-FLIGHT: Check REAL slippage for top opportunities
    const topOpps = opportunities.slice(0, 5);
    const checkedOpps = [];
    
    for (const opp of topOpps) {
      console.log(`   📊 Checking real slippage for ${opp.token}...`);
      const slippageCheck = await getRealSlippageCost(opp.tokenAddress);
      
      if (!slippageCheck.success) {
        console.log(`   ❌ ${opp.token}: ${slippageCheck.reason} - SKIPPING`);
        continue;
      }
      
      // Calculate if trade is worth it
      const expectedProfit = opp.priceChange5m; // Use 5m momentum as proxy
      const totalCost = slippageCheck.totalRoundTrip;
      const netExpected = expectedProfit - totalCost;
      
      console.log(`   ✅ ${opp.token}: Buy ${slippageCheck.buySlippage.toFixed(2)}% + Sell ${slippageCheck.sellSlippage.toFixed(2)}% = ${totalCost.toFixed(2)}% round-trip`);
      
      // Only include if potential profit exceeds slippage cost + buffer
      // Relaxed for paper testing - allow slightly negative to gather data
      const minProfitBuffer = -2; // Paper mode: accept up to -2% expected
      if (netExpected < minProfitBuffer) {
        console.log(`   ⚠️ ${opp.token}: Net expected ${netExpected.toFixed(2)}% too negative - SKIPPING`);
        continue;
      }
      
      // Add real slippage data to opportunity
      opp.realBuySlippage = slippageCheck.buySlippage;
      opp.realSellSlippage = slippageCheck.sellSlippage;
      opp.realTotalSlippage = slippageCheck.totalRoundTrip;
      opp.netExpectedProfit = netExpected;
      
      checkedOpps.push(opp);
    }
    
    console.log(`   📋 ${checkedOpps.length}/${topOpps.length} opportunities passed slippage check`);
    
    return checkedOpps;
  } catch (e) {
    console.error('[MemeScalp] Scan error:', e.message);
    return [];
  }
}

/**
 * Score a trading pair for meme potential
 */
function scorePair(pair, trendingAddresses = new Set()) {
  let score = 0;
  const breakdown = {};
  
  const liquidity = parseFloat(pair.liquidity?.usd || 0);
  const volume24h = parseFloat(pair.volume?.h24 || 0);
  const priceChange5m = parseFloat(pair.priceChange?.m5 || 0);
  const priceChange1h = parseFloat(pair.priceChange?.h1 || 0);
  const txns24h = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);
  const buyRatio = pair.txns?.h24?.buys / (txns24h || 1);
  
  // Liquidity check (need enough to exit)
  if (liquidity >= CONFIG.minLiquidityUsd && liquidity <= CONFIG.maxLiquidityUsd) {
    score += 15;
    breakdown.liquidity = 15;
  } else if (liquidity >= CONFIG.minLiquidityUsd * 0.5) {
    score += 5;
    breakdown.liquidity = 5;
  }
  
  // Volume check
  if (volume24h >= CONFIG.minVolume24h) {
    score += 15;
    breakdown.volume = 15;
  }
  
  // Price momentum (5min)
  if (priceChange5m >= CONFIG.minPriceChange5m && priceChange5m <= CONFIG.maxPriceChange5m) {
    score += 20 + Math.min(priceChange5m, 20); // Up to +40
    breakdown.momentum5m = 20 + Math.min(priceChange5m, 20);
  } else if (priceChange5m > 0) {
    score += 10;
    breakdown.momentum5m = 10;
  }
  
  // Price momentum (1h)
  if (priceChange1h > 5 && priceChange1h < 100) {
    score += 15;
    breakdown.momentum1h = 15;
  }
  
  // Buy pressure
  if (buyRatio > 0.55) {
    score += 10;
    breakdown.buyPressure = 10;
  }
  
  // Transaction count (active trading)
  if (txns24h > 100) {
    score += 10;
    breakdown.activity = 10;
  }
  
  // Trending bonus
  if (trendingAddresses.has(pair.baseToken?.address)) {
    score += 15;
    breakdown.trending = 15;
  }
  
  // Volume/Liquidity ratio (good turnover)
  const volLiqRatio = volume24h / (liquidity || 1);
  if (volLiqRatio > 1) {
    score += 10;
    breakdown.turnover = 10;
  }
  
  breakdown.total = score;
  return breakdown;
}

/**
 * Check if a position should exit (quick scalp logic)
 */
export function checkExit(position, currentPrice) {
  const entryPrice = position.entryPrice;
  const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  const holdTimeMs = Date.now() - position.entryTime;
  
  // Track peak for trailing stop
  const peak = position.peakPrice || entryPrice;
  const fromPeak = ((currentPrice - peak) / peak) * 100;
  
  // 1. Stop loss
  if (pnlPct <= -CONFIG.stopLossPct) {
    return { shouldExit: true, reason: 'STOP_LOSS', pnlPct };
  }
  
  // 2. Take profit
  if (pnlPct >= CONFIG.takeProfitPct) {
    return { shouldExit: true, reason: 'TAKE_PROFIT', pnlPct };
  }
  
  // 3. Trailing stop (if activated)
  if (pnlPct >= CONFIG.trailingActivatePct && fromPeak <= -CONFIG.trailingDistancePct) {
    return { shouldExit: true, reason: 'TRAILING_STOP', pnlPct };
  }
  
  // 4. Max hold time
  if (holdTimeMs >= CONFIG.maxHoldTimeMs) {
    return { shouldExit: true, reason: 'MAX_HOLD_TIME', pnlPct };
  }
  
  // Update peak
  return { 
    shouldExit: false, 
    pnlPct,
    newPeak: currentPrice > peak ? currentPrice : peak,
  };
}

/**
 * Get quick stats for display
 */
export function getStats() {
  return {
    strategy: 'MEME SCALP 👑',
    scanInterval: `${CONFIG.scanIntervalMs / 1000}s`,
    takeProfit: `+${CONFIG.takeProfitPct}%`,
    stopLoss: `-${CONFIG.stopLossPct}%`,
    trailingStart: `+${CONFIG.trailingActivatePct}%`,
    maxHold: `${CONFIG.maxHoldTimeMs / 60000}min`,
    positionSize: `${CONFIG.positionSizePct}%`,
  };
}

export default {
  scan,
  checkExit,
  getSlippage,
  getStats,
  isTokenOnCooldown,
  recordTokenLoss,
  getCooldownStats,
  CONFIG,
};
