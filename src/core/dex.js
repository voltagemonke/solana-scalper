/**
 * DEX Aggregator Module
 * 1inch for EVM chains, Jupiter for Solana
 * Production-ready swap execution
 */

import fetch from 'node-fetch';

// Chain IDs for 1inch
const CHAIN_IDS = {
  ethereum: 1,
  polygon: 137,
  arbitrum: 42161,
  base: 8453
};

// 1inch API endpoints
const ONEINCH_API = 'https://api.1inch.dev';
const ONEINCH_SWAP_API = `${ONEINCH_API}/swap/v6.0`;
const ONEINCH_FUSION_API = `${ONEINCH_API}/fusion/orders/v2.0`;

// Jupiter API endpoint (Solana)
const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';

// Native token addresses (used for ETH/MATIC swaps)
const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// Common tokens per chain
const TOKENS = {
  ethereum: {
    ETH: NATIVE_TOKEN,
    NATIVE: NATIVE_TOKEN,
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  },
  base: {
    ETH: NATIVE_TOKEN,
    NATIVE: NATIVE_TOKEN,
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA'
  },
  arbitrum: {
    ETH: NATIVE_TOKEN,
    NATIVE: NATIVE_TOKEN,
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
  },
  polygon: {
    MATIC: NATIVE_TOKEN,
    NATIVE: NATIVE_TOKEN,
    WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
  },
  solana: {
    SOL: 'So11111111111111111111111111111111111111112',
    NATIVE: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
  }
};

/**
 * Get 1inch API headers
 */
function getOneInchHeaders() {
  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) {
    throw new Error('ONEINCH_API_KEY not set in environment');
  }
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json'
  };
}

/**
 * Get swap quote from 1inch (EVM chains)
 */
export async function getQuoteOneInch(chain, tokenIn, tokenOut, amount) {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) {
    throw new Error(`Chain ${chain} not supported by 1inch`);
  }

  const url = new URL(`${ONEINCH_SWAP_API}/${chainId}/quote`);
  url.searchParams.set('src', tokenIn);
  url.searchParams.set('dst', tokenOut);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('includeGas', 'true');

  const response = await fetch(url.toString(), {
    headers: getOneInchHeaders(),
    timeout: 10000
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`1inch quote failed: ${error}`);
  }

  const data = await response.json();
  
  return {
    provider: '1inch',
    chain,
    tokenIn,
    tokenOut,
    amountIn: amount.toString(),
    amountOut: data.dstAmount,
    estimatedGas: data.gas,
    protocols: data.protocols // Shows routing path
  };
}

/**
 * Build swap transaction from 1inch
 * Returns raw transaction data to be signed
 */
export async function buildSwapOneInch(chain, tokenIn, tokenOut, amount, fromAddress, slippage = 1) {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) {
    throw new Error(`Chain ${chain} not supported by 1inch`);
  }

  const url = new URL(`${ONEINCH_SWAP_API}/${chainId}/swap`);
  url.searchParams.set('src', tokenIn);
  url.searchParams.set('dst', tokenOut);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('from', fromAddress);
  url.searchParams.set('slippage', slippage.toString());
  url.searchParams.set('disableEstimate', 'true'); // We estimate separately
  url.searchParams.set('allowPartialFill', 'false');

  const response = await fetch(url.toString(), {
    headers: getOneInchHeaders(),
    timeout: 15000
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`1inch swap build failed: ${error}`);
  }

  const data = await response.json();
  
  return {
    provider: '1inch',
    chain,
    chainId,
    tx: {
      to: data.tx.to,
      data: data.tx.data,
      value: data.tx.value,
      gas: data.tx.gas,
      gasPrice: data.tx.gasPrice
    },
    tokenIn,
    tokenOut,
    amountIn: amount.toString(),
    expectedAmountOut: data.dstAmount,
    minAmountOut: data.toAmount, // After slippage
    protocols: data.protocols
  };
}

/**
 * Get Jupiter API headers
 */
function getJupiterHeaders() {
  const apiKey = process.env.JUPITER_API_KEY;
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...(apiKey && { 'x-api-key': apiKey })
  };
}

/**
 * Get swap quote from Jupiter (Solana)
 */
export async function getQuoteJupiter(tokenIn, tokenOut, amount, slippageBps = 500) {
  const url = new URL(`${JUPITER_API}/quote`);
  url.searchParams.set('inputMint', tokenIn);
  url.searchParams.set('outputMint', tokenOut);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());
  // Enable dynamic slippage for volatile meme coins
  url.searchParams.set('autoSlippage', 'true');
  url.searchParams.set('maxAutoSlippageBps', '1000'); // Cap at 10%

  const response = await fetch(url.toString(), {
    headers: getJupiterHeaders(),
    timeout: 10000
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jupiter quote failed: ${error}`);
  }

  const data = await response.json();
  
  return {
    provider: 'jupiter',
    chain: 'solana',
    tokenIn,
    tokenOut,
    amountIn: amount.toString(),
    amountOut: data.outAmount,
    priceImpactPct: data.priceImpactPct,
    routePlan: data.routePlan,
    quoteResponse: data // Keep full response for swap
  };
}

/**
 * Build swap transaction from Jupiter (Solana)
 */
export async function buildSwapJupiter(quoteResponse, userPublicKey) {
  const response = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: getJupiterHeaders(),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    }),
    timeout: 15000
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jupiter swap build failed: ${error}`);
  }

  const data = await response.json();
  
  return {
    provider: 'jupiter',
    chain: 'solana',
    swapTransaction: data.swapTransaction, // Base64 encoded transaction
    lastValidBlockHeight: data.lastValidBlockHeight
  };
}

/**
 * Check if we need token approval for 1inch
 */
export async function checkAllowance(chain, tokenAddress, walletAddress) {
  // Native token doesn't need approval
  if (tokenAddress.toLowerCase() === NATIVE_TOKEN.toLowerCase()) {
    return { needsApproval: false };
  }

  const chainId = CHAIN_IDS[chain];
  const url = new URL(`${ONEINCH_SWAP_API}/${chainId}/approve/allowance`);
  url.searchParams.set('tokenAddress', tokenAddress);
  url.searchParams.set('walletAddress', walletAddress);

  const response = await fetch(url.toString(), {
    headers: getOneInchHeaders(),
    timeout: 10000
  });

  if (!response.ok) {
    throw new Error('Failed to check allowance');
  }

  const data = await response.json();
  const allowance = BigInt(data.allowance);
  
  return {
    needsApproval: allowance === 0n,
    currentAllowance: data.allowance
  };
}

/**
 * Build approval transaction for 1inch router
 */
export async function buildApproval(chain, tokenAddress, amount = null) {
  const chainId = CHAIN_IDS[chain];
  const url = new URL(`${ONEINCH_SWAP_API}/${chainId}/approve/transaction`);
  url.searchParams.set('tokenAddress', tokenAddress);
  
  // null amount = unlimited approval
  if (amount) {
    url.searchParams.set('amount', amount.toString());
  }

  const response = await fetch(url.toString(), {
    headers: getOneInchHeaders(),
    timeout: 10000
  });

  if (!response.ok) {
    throw new Error('Failed to build approval');
  }

  const data = await response.json();
  
  return {
    to: data.to,
    data: data.data,
    value: '0',
    gas: 50000 // Approval is cheap
  };
}

/**
 * Get spender address (1inch router) for approvals
 */
export async function getSpenderAddress(chain) {
  const chainId = CHAIN_IDS[chain];
  const url = `${ONEINCH_SWAP_API}/${chainId}/approve/spender`;

  const response = await fetch(url, {
    headers: getOneInchHeaders(),
    timeout: 10000
  });

  if (!response.ok) {
    throw new Error('Failed to get spender address');
  }

  const data = await response.json();
  return data.address;
}

/**
 * Unified quote function - routes to correct DEX
 */
export async function getQuote(chain, tokenIn, tokenOut, amount) {
  if (chain === 'solana') {
    return getQuoteJupiter(tokenIn, tokenOut, amount);
  } else {
    return getQuoteOneInch(chain, tokenIn, tokenOut, amount);
  }
}

/**
 * Unified swap builder - routes to correct DEX
 */
export async function buildSwap(chain, tokenIn, tokenOut, amount, fromAddress, slippage = 5) {
  if (chain === 'solana') {
    // First get quote, then build swap (5% default for meme volatility)
    const quote = await getQuoteJupiter(tokenIn, tokenOut, amount, slippage * 100);
    return buildSwapJupiter(quote.quoteResponse, fromAddress);
  } else {
    return buildSwapOneInch(chain, tokenIn, tokenOut, amount, fromAddress, slippage);
  }
}

/**
 * Format amount with decimals
 */
export function parseAmount(amount, decimals = 18) {
  const factor = 10n ** BigInt(decimals);
  const [whole, fraction = ''] = amount.toString().split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return (BigInt(whole) * factor + BigInt(paddedFraction)).toString();
}

/**
 * Format amount from raw to readable
 */
export function formatAmount(rawAmount, decimals = 18) {
  const amount = BigInt(rawAmount);
  const factor = 10n ** BigInt(decimals);
  const whole = amount / factor;
  const fraction = amount % factor;
  const fractionStr = fraction.toString().padStart(decimals, '0');
  return `${whole}.${fractionStr}`.replace(/\.?0+$/, '');
}

export default {
  getQuote,
  buildSwap,
  getQuoteOneInch,
  buildSwapOneInch,
  getQuoteJupiter,
  buildSwapJupiter,
  checkAllowance,
  buildApproval,
  getSpenderAddress,
  parseAmount,
  formatAmount,
  TOKENS,
  CHAIN_IDS,
  NATIVE_TOKEN
};
