# Crypto Screener

Multi-exchange USDT futures screener with real-time data, spaghetti charts, top performers, and watchlist.

![Screenshot](https://via.placeholder.com/1200x600?text=Crypto+Screener)

## Features

- **Multi-Exchange Support**: MEXC, Binance, Bybit USDT futures
- **Screener**: 150+ columns, filters, presets (High Volume, OI Spike, Big Movers, High Funding)
- **Spaghetti Charts**: Price and volume visualizations with timeframe selection
- **Top Performers**: Gainers/losers for 24h, 7d, 30d periods
- **Watchlist**: Track favorites across all exchanges
- **TradingView Charts**: Interactive charts per symbol
- **Dark Terminal UI**: Professional crypto-native design

## Tech Stack

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS
- MEXC/Binance/Bybit Public APIs
- CoinGecko (MCAP data)

## Getting Started

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```

## Environment Variables

Create `.env.local`:

```env
MEXC_ACCESS_KEY=your_mexc_key
MEXC_SECRET_KEY=your_mexc_secret
DEEPSEEK_API_KEY=your_deepseek_key
LCW_API_KEY=your_livecoinwatch_key  # optional
```

## Pages

- `/` - MEXC Screener
- `/binance` - Binance Screener
- `/bybit` - Bybit Screener  
- `/spaghetti/price` - MEXC Price Spaghetti
- `/spaghetti/volume` - MEXC Volume Spaghetti
- `/performers` - Top Gainers/Losers
- `/watchlist` - Global Watchlist

## Deploy to Vercel

```bash
# Push to GitHub
git push origin main

# Import at https://vercel.com/new
```

Add environment variables in Vercel dashboard under **Settings → Environment Variables**.

## License

MIT