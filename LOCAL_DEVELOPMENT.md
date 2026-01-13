# Local Development Setup

## Quick Start

For **full functionality** including wallet connection and trading:

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Set Up Environment Variables

Create `.env.local` file in the project root:

```bash
POLYMARKET_MAGIC_PK=0xbaa7be4ea483b9017e806003f8f6f89b6810fa1485cfcecb121fc212bc336b51
POLYMARKET_BUILDER_API_KEY=019bb196-0ffa-73b0-8dc0-9598392bcdac
POLYMARKET_BUILDER_SECRET=iuA1pf0WkPBSyDXdO8xaIk3b02y_yOqlJ7h-SpFg-Ig=
POLYMARKET_BUILDER_PASSPHRASE=d633f4dd7c36bddb0037d2bc9a167c0ce77db9f14d90f282564bfaaea5ee5961
POLYGON_RPC_URL=https://polygon-rpc.com
```

### Step 3: Run Development Servers

You need **two terminals**:

**Terminal 1 - Vercel Dev Server (API Routes):**
```bash
# Install Vercel CLI if not already installed
npm install -g vercel

# Run Vercel dev server (handles /api/* routes)
vercel dev
```

**Terminal 2 - Vite Dev Server (Frontend):**
```bash
# Run Vite dev server (handles frontend)
npm run dev
```

### Step 4: Access the Application

- Frontend: http://localhost:3000 (Vite)
- API Routes: Handled by Vercel dev server (port 3000 or as configured)

## Testing Wallet Connection

1. Open http://localhost:3000 in your browser
2. Click "Connect Wallet" button
3. Check browser console for any errors
4. Verify wallet addresses are displayed

## Troubleshooting

### "Wallet not configured" Error

- Ensure `.env.local` exists in project root
- Verify `POLYMARKET_MAGIC_PK` is set correctly
- Restart both dev servers after changing `.env.local`

### API Routes Not Working

- Ensure `vercel dev` is running in a separate terminal
- Check that Vercel dev server is listening on the correct port
- Verify API routes are accessible (check Network tab in browser)

### Import Errors

- Ensure all dependencies are installed: `npm install`
- Check that `viem` and `@polymarket/builder-signing-sdk` are installed
- Try deleting `node_modules` and reinstalling: `rm -rf node_modules && npm install`

### Port Conflicts

If port 3000 is already in use:
- Vercel dev will prompt you to use a different port
- Update Vite config to use a different port if needed

## Alternative: Frontend Only Mode

If you only want to test the frontend (without wallet features):

```bash
npm run dev
```

**Limitations:**
- Wallet connection will fail
- Trading session initialization will fail
- Other features (price streaming, events) will work

## Production Deployment

For production, deploy to Vercel:
- All API routes work automatically
- Environment variables set in Vercel dashboard
- No need to run separate servers
