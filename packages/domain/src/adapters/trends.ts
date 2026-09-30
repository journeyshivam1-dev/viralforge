/**
 * Real trend sources for daily topic ideation (geo = India).
 * - Google Trends "trending now" RSS (no key).
 * - YouTube Data API v3 mostPopular per category (YOUTUBE_API_KEY, sent as a header).
 * Output is untrusted text: callers must sanitize before prompting.
 */

export interface TrendItem {
  source: 'google_trends' | 'youtube_trending';
  title: string;
  traffic?: string;
  context?: string;
  url?: string;
  categoryId?: string;
}

const FETCH_TIMEOUT_MS = 15_000;

/** YouTube category ids most relevant per niche (regionCode=IN). */
export const YOUTUBE_CATEGORIES: Record<string, string[]> = {
  cartoon: ['1', '23'], // Film & Animation, Comedy
  food: ['26'], // Howto & Style
  health: ['26', '17'], // Howto & Style, Sports
  tech: ['28'], // Science & Technology
  edtech: ['27'], // Education
};

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]*>/g, '')
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeEntities(match[1]) : undefined;
}

export function parseGoogleTrendsRss(xml: string, limit = 25): TrendItem[] {
  const items: TrendItem[] = [];
  for (const block of xml.split(/<item>/i).slice(1)) {
    const title = tag(block, 'title');
    if (!title) continue;
    const news = [...block.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/gi)]
      .map((match) => decodeEntities(match[1]))
      .slice(0, 2);
    items.push({
      source: 'google_trends',
      title: title.slice(0, 200),
      traffic: tag(block, 'ht:approx_traffic'),
      context: news.join(' | ').slice(0, 400) || undefined,
      url: tag(block, 'link'),
    });
    if (items.length >= limit) break;
  }
  return items;
}

export async function fetchGoogleTrends(geo = 'IN'): Promise<TrendItem[]> {
  const response = await fetch(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, {
    headers: { Accept: 'application/rss+xml, application/xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google Trends RSS failed (${response.status})`);
  return parseGoogleTrendsRss(await response.text());
}

export async function fetchYouTubeTrending(apiKey: string | undefined, categoryIds: string[], regionCode = 'IN'): Promise<TrendItem[]> {
  if (!apiKey) return [];
  const results: TrendItem[] = [];
  for (const categoryId of categoryIds) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet,statistics');
    url.searchParams.set('chart', 'mostPopular');
    url.searchParams.set('regionCode', regionCode);
    url.searchParams.set('videoCategoryId', categoryId);
    url.searchParams.set('maxResults', '15');
    const response = await fetch(url, {
      // API key in a header so it never appears in logged URLs.
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Some categories are not available for mostPopular in every region; skip them.
    if (response.status === 400 || response.status === 404) continue;
    if (!response.ok) throw new Error(`YouTube trending failed (${response.status})`);
    const payload = (await response.json()) as {
      items?: Array<{ id?: string; snippet?: { title?: string; channelTitle?: string; tags?: string[] }; statistics?: { viewCount?: string } }>;
    };
    for (const video of payload.items || []) {
      if (!video.snippet?.title) continue;
      results.push({
        source: 'youtube_trending',
        title: video.snippet.title.slice(0, 200),
        traffic: video.statistics?.viewCount ? `${video.statistics.viewCount} views` : undefined,
        context: [video.snippet.channelTitle, ...(video.snippet.tags || []).slice(0, 5)].filter(Boolean).join(', ').slice(0, 300),
        url: video.id ? `https://www.youtube.com/watch?v=${video.id}` : undefined,
        categoryId,
      });
    }
  }
  return results;
}

/** Cheap keyword pre-filter so the LLM only sees plausibly relevant trends. */
export function filterTrendsForNiche(items: TrendItem[], keywords: string[], limit = 15): TrendItem[] {
  const lowered = keywords.map((keyword) => keyword.toLowerCase());
  const scored = items.map((item) => {
    const haystack = `${item.title} ${item.context || ''}`.toLowerCase();
    const score = lowered.reduce((total, keyword) => total + (haystack.includes(keyword) ? 1 : 0), 0);
    // YouTube items were already fetched per niche category.
    return { item, score: score + (item.source === 'youtube_trending' ? 1 : 0) };
  });
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.item);
}
