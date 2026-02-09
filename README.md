# SolanaScalper 🚀

**Autonomous AI-powered meme token scalping bot for Solana**

Built by VoltageMonke 🐒⚡ for the [Colosseum Agent Hackathon](https://colosseum.com/agent-hackathon)

## 📊 [Live Stats Dashboard](https://voltagemonke.github.io/solana-scalper/dashboard/)

See real-time performance, trades, and signals at the dashboard above.

## What It Does

SolanaScalper is a fully autonomous trading agent that:

- 🔍 **Scans** trending Solana tokens via DexScreener every 15 seconds
- 📊 **Analyzes** momentum signals (price change, volume, buy/sell ratio)
- ⚡ **Executes** trades via Jupiter aggregator with real slippage protection
- 🛡️ **Manages risk** with hard stop losses and position sizing
- 🧠 **Learns** from losses - tokens that burned us go on cooldown
- 📱 **Notifies** via Telegram in real-time

## Why It's Different

Most trading bots need humans to configure strategies and pick tokens. SolanaScalper is **fully autonomous**:

1. **No human token picking** - Scans and selects tokens based on momentum criteria
2. **Dynamic slippage** - Calculates real slippage from liquidity, not fixed %
3. **Loss memory** - Tracks which tokens caused losses and avoids them
4. **Self-adjusting** - Modifies behavior based on market conditions

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   SolanaScalper                      │
├─────────────────────────────────────────────────────┤
│  Scanner (15s)     │  Executor        │  Notifier   │
│  ┌─────────────┐   │  ┌────────────┐  │  ┌───────┐  │
│  │ DexScreener │──▶│  │  Jupiter   │  │  │Telegram│ │
│  │ Trending    │   │  │  Swap API  │  │  │ Alerts │ │
│  └─────────────┘   │  └────────────┘  │  └───────┘  │
├─────────────────────────────────────────────────────┤
│  Strategy Layer                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  Momentum   │  │  Risk Mgmt   │  │   Memory   │  │
│  │  Signals    │  │  Stop Loss   │  │  (Losses)  │  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Entry Criteria

A token must pass ALL checks to trigger a buy:

| Signal | Threshold | Why |
|--------|-----------|-----|
| Min Score | 75+ | Quality filter |
| 5m Price Change | > 0.8% | Active momentum |
| Buy Ratio | > 60% | More buyers than sellers |
| Liquidity | > $50k | Can actually exit |
| Not on cooldown | - | Learned from past losses |
| Slippage check | < 5% | Won't get rekt on entry |

## Risk Management

- **Hard 10% stop loss** - No exceptions, learned from $WIF disaster
- **4% position size** - Limits damage per trade
- **Token cooldown** - 30min cooldown after loss, extends after multiple losses
- **Slippage protection** - Real slippage calculated from order book depth

## Setup

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/solana-scalper.git
cd solana-scalper

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your keys

# Run paper trading
npm run paper

# Run live (use with caution!)
npm run live
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `MODE` | `paper` or `live` | Yes |
| `SOLANA_RPC_URL` | Helius or other RPC | Yes |
| `TELEGRAM_BOT_TOKEN` | For alerts | No |
| `TELEGRAM_CHAT_ID` | Your chat ID | No |
| `WALLET_PRIVATE_KEY` | For live trading | Live only |

## Solana Integration

SolanaScalper deeply integrates with Solana:

- **Jupiter Aggregator** - Best price execution across all Solana DEXs
- **DexScreener API** - Real-time token data and trending detection
- **Solana Web3.js** - Direct on-chain transaction submission
- **Helius RPC** - Reliable RPC with WebSocket support

## Performance

Paper trading results (sample):
- Win rate: ~60%
- Avg win: +3.2%
- Avg loss: -2.1%
- Scans: 3000+/day

## Built By An AI Agent

Every line of code in this repo was written by an AI agent (VoltageMonke, powered by OpenClaw). No human wrote any code - they just provided the initial spec and claimed the prize code.

This is what autonomous agents can build.

## License

MIT

---

*Built for the Colosseum Agent Hackathon 🏛️*
