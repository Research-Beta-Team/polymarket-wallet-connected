# Vercel Deployment Guide

This project uses Vercel serverless functions to proxy API requests and avoid CORS issues in production.

## Setup

The project includes:

1. **`vercel.json`** - Configuration for API route rewrites
2. **`api/proxy.ts`** - Serverless function to proxy Polymarket Gamma API requests
3. **`api/clob-proxy.ts`** - Serverless function to proxy CLOB API requests

## How It Works

### Development
- Uses Vite proxy (configured in `vite.config.ts`)
- Requests to `/api/polymarket/*` are proxied to `https://gamma-api.polymarket.com/*`

### Production (Vercel)
- Uses Vercel serverless functions
- Requests to `/api/polymarket/*` are rewritten to `/api/proxy/*`
- The serverless function forwards requests to Polymarket API
- CORS headers are added to allow browser requests

## API Endpoints

### Polymarket Gamma API Proxy
- **Route**: `/api/polymarket/:path*`
- **Function**: `api/proxy.ts`
- **Example**: `/api/polymarket/events/slug/btc-up-down-15m-1234567890`

### CLOB API Proxy
- **Route**: `/api/clob-proxy`
- **Function**: `api/clob-proxy.ts`
- **Query Params**: `side` (BUY/SELL), `token_id`
- **Example**: `/api/clob-proxy?side=BUY&token_id=0x123...`

## Deployment

1. Push code to your repository
2. Connect to Vercel
3. Vercel will automatically detect and deploy the serverless functions
4. The functions will be available at your Vercel domain

## Troubleshooting

If CLOB Token IDs, Condition IDs, or Question IDs are not showing:

1. Check Vercel function logs in the dashboard
2. Verify the proxy is working by checking network requests in browser dev tools
3. Ensure `vercel.json` is in the root directory
4. Make sure `api/proxy.ts` and `api/clob-proxy.ts` exist in the `api/` directory

## Local Testing

To test the serverless functions locally:

```bash
# Install Vercel CLI
npm i -g vercel

# Run locally
vercel dev
```

This will start a local server that mimics Vercel's behavior.
