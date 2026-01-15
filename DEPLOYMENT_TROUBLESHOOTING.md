# Vercel Deployment Troubleshooting

## Issue: No Logs in Vercel Dashboard

If you see no logs in Vercel, the serverless function might not be executing. Here's how to diagnose:

### Step 1: Test Basic Function

1. Visit: `https://your-app.vercel.app/api/hello`
2. Should return JSON with message
3. Check Vercel logs - you should see `[Hello] Function executed`

### Step 2: Test Polymarket Proxy

1. Visit: `https://your-app.vercel.app/api/polymarket/events/slug/btc-updown-15m-1768064400`
2. Check browser Network tab - should return JSON
3. Check Vercel logs - should see `[Proxy] Function called!`

### Step 3: Check Vercel Dashboard

1. Go to your Vercel project
2. Click on "Functions" tab
3. You should see:
   - `api/hello.ts`
   - `api/polymarket/[...path].ts`
   - `api/clob-proxy.ts`
4. If functions don't appear, they're not being deployed

### Step 4: Verify File Structure

Ensure your repo has:
```
api/
├── hello.ts
├── test.ts
├── clob-proxy.ts
└── polymarket/
    └── [...path].ts
```

### Step 5: Check Build Logs

In Vercel dashboard:
1. Go to "Deployments"
2. Click on latest deployment
3. Check "Build Logs"
4. Look for errors about API functions

### Common Issues:

1. **Functions not appearing**: API files might be in `.gitignore` or not committed
2. **404 errors**: Route not matching - check URL structure
3. **500 errors**: Function erroring - check function logs
4. **No logs**: Function not executing - check if route is correct

### Quick Fix:

If nothing works, try:
1. Delete `vercel.json` temporarily
2. Redeploy
3. Vercel should auto-detect API functions
4. Check if functions appear in dashboard
