# Vercel API Debugging Guide

## Issue: Condition ID, Question ID, and CLOB Token IDs Not Showing

### Step 1: Test API Endpoint Directly

Test the API proxy endpoint directly in your browser or using curl:

```
https://your-app.vercel.app/api/polymarket/events/slug/btc-updown-15m-1768294800
```

Replace `1768294800` with a recent timestamp (15-minute interval).

**Expected Response:**
```json
{
  "slug": "btc-updown-15m-1768294800",
  "title": "...",
  "markets": [
    {
      "clobTokenIds": ["0x...", "0x..."],
      "conditionId": "0x...",
      "questionID": "0x...",
      "tokens": [...]
    }
  ]
}
```

### Step 2: Check Vercel Function Logs

1. Go to Vercel Dashboard → Your Project
2. Click "Functions" tab
3. Click on `/api/polymarket/[...path]`
4. Check the "Logs" tab

Look for:
- `[Proxy] Function called!` - Confirms function is executing
- `[Proxy] Response structure for...` - Shows what data is in the response
- `[Proxy] Market[0] full structure:` - Shows the full market structure

### Step 3: Check Browser Console

Open browser DevTools (F12) and check the Console tab. Look for:
- `[PolymarketAPI] Response for...` - Shows what the frontend received
- `[PolymarketAPI] Extraction results for...` - Shows if extraction succeeded
- `[PolymarketAPI] Final event data for...` - Shows final extracted values

### Step 4: Common Issues

#### Issue 1: API Proxy Not Working
**Symptoms:** 404 or 500 errors when accessing `/api/polymarket/*`

**Solution:**
- Verify `api/polymarket/[...path].ts` exists
- Check Vercel function logs for errors
- Ensure the file is committed and deployed

#### Issue 2: Data Structure Different Than Expected
**Symptoms:** API returns data but IDs are missing

**Solution:**
- Check Vercel logs for `[Proxy] Market[0] full structure:`
- Compare with expected structure in `DATA_FETCHING_DOCUMENTATION.md`
- Update extraction logic if structure changed

#### Issue 3: Extraction Logic Failing
**Symptoms:** Data exists in response but not extracted

**Solution:**
- Check browser console for `[PolymarketAPI] Extraction results`
- Look for warnings about missing data
- Verify extraction logic in `src/polymarket-api.ts`

### Step 5: Manual Testing

Test a specific event slug:

```bash
# Replace with your Vercel URL and a valid slug
curl https://your-app.vercel.app/api/polymarket/events/slug/btc-updown-15m-1768294800
```

Check if the response contains:
- `markets[0].clobTokenIds`
- `markets[0].conditionId`
- `markets[0].questionID`

### Step 6: Verify Environment

Ensure the API proxy is working:
1. The endpoint should return JSON (not HTML)
2. CORS headers should be present
3. Response should match Polymarket API structure

### Debugging Commands

```bash
# Test API endpoint
curl -v https://your-app.vercel.app/api/polymarket/events/slug/btc-updown-15m-1768294800

# Check response headers
curl -I https://your-app.vercel.app/api/polymarket/events/slug/btc-updown-15m-1768294800
```

### Next Steps

If IDs are still missing after checking logs:
1. Share the Vercel function logs output
2. Share the browser console output
3. Share a sample API response from the proxy endpoint

This will help identify if the issue is:
- API proxy not working
- Data structure changed
- Extraction logic needs updating
