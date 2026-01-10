// Use proxy in both development and production to avoid CORS issues
const GAMMA_API_BASE = '/api/polymarket';

export interface PolymarketEvent {
  slug: string;
  title: string;
  description?: string;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  conditionId?: string;
  condition_id?: string;
  questionId?: string;
  questionID?: string; // Note: API uses capital ID
  question_id?: string;
  clobTokenIds?: string[] | string; // Can be array or stringified JSON
  clob_token_ids?: string[] | string;
  condition?: { id?: string };
  question?: { id?: string };
  tokens?: Array<{ token_id?: string; tokenId?: string; id?: string }>;
  markets?: Array<{
    conditionId?: string;
    condition_id?: string;
    questionId?: string;
    questionID?: string;
    question_id?: string;
    tokens?: Array<{ token_id?: string; tokenId?: string; id?: string }>;
  }>;
  liquidity?: number;
  volume?: number;
  [key: string]: any; // For other fields that might be present
}

export class PolymarketAPI {
  static async fetchEventBySlug(slug: string): Promise<PolymarketEvent | null> {
    try {
      const apiUrl = `${GAMMA_API_BASE}/events/slug/${slug}`;
      console.log(`[PolymarketAPI] Fetching: ${apiUrl}`);
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        // Add mode to handle CORS
        mode: 'cors',
        cache: 'no-cache',
      });
      
      console.log(`[PolymarketAPI] Response status: ${response.status} for ${slug}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          return null; // Event not found
        }
        const errorText = await response.text().catch(() => '');
        console.error(`[PolymarketAPI] Error ${response.status}:`, errorText);
        throw new Error(`Failed to fetch event: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Log the raw response for debugging (remove in production if needed)
      console.log(`[PolymarketAPI] Response for ${slug}:`, {
        hasConditionId: !!data.conditionId || !!data.condition_id,
        hasQuestionId: !!data.questionID || !!data.questionId,
        hasClobTokenIds: !!data.clobTokenIds || !!data.clob_token_ids,
        marketsCount: data.markets?.length || 0,
      });
      
      // Polymarket API returns nested structure, extract the fields we need
      // Try multiple possible locations for these fields
      const extractConditionId = (d: any): string | undefined => {
        return d.conditionId || d.condition_id || d.condition?.id || 
               d.markets?.[0]?.conditionId || d.markets?.[0]?.condition_id ||
               d.conditionId || d.conditions?.[0]?.id;
      };
      
      const extractQuestionId = (d: any): string | undefined => {
        return d.questionID || d.questionId || d.question_id || d.question?.id || 
               d.markets?.[0]?.questionID || d.markets?.[0]?.questionId || d.markets?.[0]?.question_id ||
               d.questions?.[0]?.id;
      };
      
      const extractClobTokenIds = (d: any): string[] | undefined => {
        // Check markets array first (most common location based on API response)
        if (d.markets && Array.isArray(d.markets) && d.markets.length > 0) {
          const market = d.markets[0];
          if (market.clobTokenIds) {
            if (typeof market.clobTokenIds === 'string') {
              try {
                const parsed = JSON.parse(market.clobTokenIds);
                if (Array.isArray(parsed)) {
                  console.log('Extracted clobTokenIds from markets[0]:', parsed);
                  return parsed;
                }
              } catch (e) {
                console.warn('Failed to parse markets[0].clobTokenIds as JSON:', e);
              }
            } else if (Array.isArray(market.clobTokenIds)) {
              console.log('Extracted clobTokenIds from markets[0] (already array):', market.clobTokenIds);
              return market.clobTokenIds;
            }
          }
        }
        
        // Try top-level clobTokenIds
        if (d.clobTokenIds) {
          if (typeof d.clobTokenIds === 'string') {
            try {
              const parsed = JSON.parse(d.clobTokenIds);
              if (Array.isArray(parsed)) {
                console.log('Extracted clobTokenIds from top level:', parsed);
                return parsed;
              }
            } catch (e) {
              console.warn('Failed to parse clobTokenIds as JSON:', e);
            }
          } else if (Array.isArray(d.clobTokenIds)) {
            console.log('Extracted clobTokenIds from top level (already array):', d.clobTokenIds);
            return d.clobTokenIds;
          }
        }
        
        // Try other possible locations
        if (d.clob_token_ids) {
          if (typeof d.clob_token_ids === 'string') {
            try {
              const parsed = JSON.parse(d.clob_token_ids);
              if (Array.isArray(parsed)) {
                return parsed;
              }
            } catch (e) {
              // Ignore parse errors
            }
          } else if (Array.isArray(d.clob_token_ids)) {
            return d.clob_token_ids;
          }
        }
        
        // Try extracting from tokens/outcomes arrays
        if (d.tokens && Array.isArray(d.tokens)) {
          return d.tokens.map((t: any) => t.token_id || t.tokenId || t.id).filter(Boolean);
        }
        if (d.markets?.[0]?.tokens && Array.isArray(d.markets[0].tokens)) {
          return d.markets[0].tokens.map((t: any) => t.token_id || t.tokenId || t.id).filter(Boolean);
        }
        if (d.outcomes && Array.isArray(d.outcomes)) {
          return d.outcomes.map((o: any) => o.token_id || o.tokenId || o.id).filter(Boolean);
        }
        
        console.warn('Could not find clobTokenIds in any location');
        return undefined;
      };
      
      // Extract the fields first
      const extractedClobTokenIds = extractClobTokenIds(data);
      const extractedConditionId = extractConditionId(data);
      const extractedQuestionId = extractQuestionId(data);
      
      const event: PolymarketEvent = {
        slug: data.slug || '',
        title: data.title || data.question || '',
        description: data.description,
        startDate: data.startDate || data.start_date || '',
        endDate: data.endDate || data.end_date || '',
        active: data.active || false,
        closed: data.closed || false,
        conditionId: extractedConditionId,
        questionId: extractedQuestionId,
        questionID: extractedQuestionId, // Also set questionID for compatibility
        clobTokenIds: extractedClobTokenIds as string[], // Ensure it's an array, not string
        liquidity: data.liquidity,
        volume: data.volume,
        ...data // Include any other fields for debugging
      };
      
      // Override with extracted values to ensure they're not overwritten by spread
      event.conditionId = extractedConditionId;
      event.questionId = extractedQuestionId;
      event.questionID = extractedQuestionId;
      event.clobTokenIds = extractedClobTokenIds as string[];
      
      console.log(`Extracted event data for ${slug}:`, {
        conditionId: event.conditionId,
        questionId: event.questionId,
        questionID: event.questionID,
        clobTokenIds: event.clobTokenIds,
        clobTokenIdsType: typeof event.clobTokenIds,
        clobTokenIdsIsArray: Array.isArray(event.clobTokenIds)
      });
      
      return event;
    } catch (error) {
      console.error(`Error fetching event ${slug}:`, error);
      
      // Provide more specific error messages
      if (error instanceof TypeError && error.message.includes('fetch')) {
        // This is likely a CORS or network error
        throw new Error('Network error: Unable to connect to Polymarket API. This may be due to CORS restrictions. Please check your network connection or use a CORS proxy.');
      }
      
      throw error;
    }
  }

  static async fetchMultipleEvents(slugs: string[]): Promise<Array<PolymarketEvent | null>> {
    const promises = slugs.map(slug => this.fetchEventBySlug(slug));
    return Promise.all(promises);
  }
}

