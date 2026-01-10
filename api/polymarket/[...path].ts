import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  // Get the path segments from the catch-all route
  const pathSegments = req.query.path as string[] | string | undefined;
  
  // Convert to array and join
  let apiPath = '';
  if (pathSegments) {
    if (Array.isArray(pathSegments)) {
      apiPath = pathSegments.join('/');
    } else {
      apiPath = pathSegments;
    }
  }
  
  if (!apiPath) {
    return res.status(400).json({
      error: 'No API path provided',
      query: req.query,
    });
  }
  
  // Construct the full URL
  const baseUrl = `https://gamma-api.polymarket.com/${apiPath}`;
  
  // Forward query parameters (excluding 'path')
  const queryParams = new URLSearchParams();
  Object.entries(req.query).forEach(([key, value]) => {
    if (key !== 'path' && value) {
      if (Array.isArray(value)) {
        value.forEach(v => queryParams.append(key, String(v)));
      } else {
        queryParams.append(key, String(value));
      }
    }
  });
  
  const fullUrl = queryParams.toString() 
    ? `${baseUrl}?${queryParams.toString()}`
    : baseUrl;
  
  console.log(`[Proxy] Requesting: ${fullUrl}`);

  try {
    const response = await fetch(fullUrl, {
      method: req.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`[Proxy] API error: ${response.status} - ${errorText}`);
      return res.status(response.status).json({
        error: `API returned ${response.status}`,
        status: response.status,
        details: errorText,
      });
    }

    const data = await response.json();
    
    // Log response structure for debugging (only for events endpoints)
    if (apiPath.includes('events/slug')) {
      console.log(`[Proxy] Response structure for ${apiPath}:`, {
        hasMarkets: !!data.markets,
        marketsLength: data.markets?.length || 0,
        hasClobTokenIds: !!data.clobTokenIds || !!data.clob_token_ids,
        hasConditionId: !!data.conditionId || !!data.condition_id,
        hasQuestionId: !!data.questionID || !!data.questionId,
        market0ClobTokenIds: data.markets?.[0]?.clobTokenIds ? 'exists' : 'missing',
        market0Tokens: data.markets?.[0]?.tokens?.length || 0,
      });
    }
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    return res.status(200).json(data);
  } catch (error) {
    console.error('[Proxy] Error:', error);
    return res.status(500).json({
      error: 'Failed to fetch from Polymarket API',
      message: error instanceof Error ? error.message : 'Unknown error',
      url: fullUrl,
    });
  }
}
