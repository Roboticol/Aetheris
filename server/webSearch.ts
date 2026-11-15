export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function stripHtmlTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapDuckDuckGoRedirect(rawHref: string): string {
  const decoded = decodeHtmlEntities(rawHref.trim());
  if (!decoded) return '';
  try {
    const normalized = decoded.startsWith('//') ? `https:${decoded}` : decoded;
    const parsed = new URL(normalized, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return uddg;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // Ignore malformed href
  }
  return '';
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  if (
    !lower ||
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower === '0.0.0.0' ||
    lower === '::1' ||
    lower === '[::1]' ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4Match) {
    const [, aStr, bStr] = ipv4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return true;
    }
  }

  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
    return true;
  }

  return false;
}

async function searchDuckDuckGoHtml(query: string, limit: number): Promise<WebSearchResultItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7500);
  try {
    const form = new URLSearchParams({ q: query });
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      body: form.toString(),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    if (html.includes('anomaly-modal') || html.includes('bots use DuckDuckGo too')) {
      return [];
    }

    const items: WebSearchResultItem[] = [];
    const blockRegex = /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(html)) !== null && items.length < limit) {
      const block = match[1];
      const titleLink = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
        block
      );
      if (!titleLink) continue;

      const resolvedUrl = unwrapDuckDuckGoRedirect(titleLink[1]);
      const title = stripHtmlTags(titleLink[2]);
      if (!resolvedUrl || !title || resolvedUrl.includes('duckduckgo.com/y.js')) continue;

      const snippetMatch = /<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(
        block
      );
      const snippet = snippetMatch ? stripHtmlTags(snippetMatch[1]) : '';
      items.push({ title, url: resolvedUrl, snippet });
    }

    if (items.length === 0) {
      const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch: RegExpExecArray | null;
      while ((linkMatch = linkRegex.exec(html)) !== null && items.length < limit) {
        const resolvedUrl = unwrapDuckDuckGoRedirect(linkMatch[1]);
        const title = stripHtmlTags(linkMatch[2]);
        if (!resolvedUrl || !title || resolvedUrl.includes('duckduckgo.com/y.js')) continue;
        items.push({ title, url: resolvedUrl, snippet: '' });
      }
    }

    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchDuckDuckGoInstant(query: string, limit: number): Promise<WebSearchResultItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{
        Text?: string;
        FirstURL?: string;
        Topics?: Array<{ Text?: string; FirstURL?: string }>;
      }>;
    };

    const results: WebSearchResultItem[] = [];
    if (data.AbstractURL && data.AbstractText) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
      });
    }

    for (const topic of data.RelatedTopics ?? []) {
      if (results.length >= limit) break;
      if (topic.FirstURL && topic.Text) {
        results.push({
          title: topic.Text.split(' - ')[0]?.slice(0, 90) || topic.FirstURL,
          url: topic.FirstURL,
          snippet: topic.Text,
        });
      } else if (Array.isArray(topic.Topics)) {
        for (const sub of topic.Topics) {
          if (results.length >= limit) break;
          if (sub.FirstURL && sub.Text) {
            results.push({
              title: sub.Text.split(' - ')[0]?.slice(0, 90) || sub.FirstURL,
              url: sub.FirstURL,
              snippet: sub.Text,
            });
          }
        }
      }
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchWikipediaFallback(query: string, limit: number): Promise<WebSearchResultItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&srlimit=${Math.min(5, limit)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AetherisIDE/1.0 (https://localhost)' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: {
        search?: Array<{ title: string; snippet: string }>;
      };
    };
    return (data.query?.search ?? []).map((entry) => ({
      title: `${entry.title} — Wikipedia`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(entry.title.replace(/ /g, '_'))}`,
      snippet: stripHtmlTags(entry.snippet),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchHackerNewsAlgolia(query: string, limit: number): Promise<WebSearchResultItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(5, limit)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      hits?: Array<{
        title?: string;
        url?: string;
        objectID?: string;
        story_text?: string | null;
        author?: string;
        points?: number;
      }>;
    };
    const items: WebSearchResultItem[] = [];
    for (const hit of data.hits ?? []) {
      if (items.length >= limit) break;
      if (!hit.title) continue;
      const targetUrl =
        hit.url || (hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : '');
      if (!targetUrl) continue;
      items.push({
        title: hit.title,
        url: targetUrl,
        snippet: hit.story_text
          ? stripHtmlTags(hit.story_text).slice(0, 260)
          : `Discussion (${hit.points ?? 0} pts by ${hit.author ?? 'user'})`,
      });
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function performWebSearch(
  rawQuery: string,
  maxResults = 6
): Promise<WebSearchResultItem[]> {
  const query = rawQuery.trim();
  if (!query) return [];
  const clamped = Math.max(1, Math.min(10, maxResults));

  const seenUrls = new Set<string>();
  const merged: WebSearchResultItem[] = [];
  const pushUnique = (list: WebSearchResultItem[]) => {
    for (const item of list) {
      if (merged.length >= clamped) break;
      const key = item.url.trim();
      if (!key || seenUrls.has(key)) continue;
      seenUrls.add(key);
      merged.push(item);
    }
  };

  const ddgHtml = await searchDuckDuckGoHtml(query, clamped);
  pushUnique(ddgHtml);

  if (merged.length < Math.min(3, clamped)) {
    const [ddgInstant, wiki, hn] = await Promise.all([
      searchDuckDuckGoInstant(query, clamped),
      searchWikipediaFallback(query, 3),
      searchHackerNewsAlgolia(query, 3),
    ]);
    pushUnique(ddgInstant);
    pushUnique(hn);
    pushUnique(wiki);
  }

  return merged.slice(0, clamped);
}

export async function fetchWebPageContent(rawUrl: string): Promise<{
  title: string;
  url: string;
  content: string;
}> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error('Access to local or private network addresses is blocked.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const res = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} when fetching ${parsed.hostname}`);
    }

    const finalUrl = new URL(res.url || parsed.toString());
    if (isPrivateOrLocalHost(finalUrl.hostname)) {
      throw new Error('Redirect to private network address is blocked.');
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const rawBody = (await res.text()).slice(0, 650_000);

    if (contentType.includes('application/json') || contentType.includes('text/plain') || contentType.includes('text/markdown')) {
      return {
        title: finalUrl.hostname + finalUrl.pathname,
        url: finalUrl.toString(),
        content: rawBody.slice(0, 12_000),
      };
    }

    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawBody);
    const title = titleMatch ? stripHtmlTags(titleMatch[1]).slice(0, 140) : finalUrl.hostname;

    const cleanedHtml = rawBody
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|tr|pre|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n');

    const textLines = decodeHtmlEntities(cleanedHtml.replace(/<[^>]+>/g, ' '))
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l.length > 0);

    return {
      title: title || finalUrl.toString(),
      url: finalUrl.toString(),
      content: textLines.join('\n').slice(0, 12_000),
    };
  } finally {
    clearTimeout(timer);
  }
}
