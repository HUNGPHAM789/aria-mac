// lib/aria/search.ts
// Tavily-powered agentic search with query decomposition + iterative re-query

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

export interface AgenticSearchResult {
  results: SearchResult[];
  subqueries: string[];
  iterations: number;
  answer?: string;
}

export async function tavilySearch(
  query: string,
  options?: { maxResults?: number; searchDepth?: 'basic' | 'advanced' },
): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey || apiKey === 'your_tavily_api_key_here') {
    console.warn('[ARIA] TAVILY_API_KEY not set — search disabled');
    return [];
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: options?.maxResults ?? 5,
        search_depth: options?.searchDepth ?? 'basic',
        include_answer: true,
      }),
    });

    if (!res.ok) {
      console.warn(`[ARIA] Tavily search failed: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
        published_date?: string;
      }>;
      answer?: string;
    };

    // Stash the answer on the first result so callers can grab it
    const results: SearchResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
      score: r.score ?? 0,
      published_date: r.published_date,
    }));

    // Attach answer as a non-enumerable property so agenticSearch can read it
    if (data.answer) {
      (results as unknown as { _answer: string })._answer = data.answer;
    }

    return results;
  } catch (err) {
    console.warn('[ARIA] Tavily search error:', err);
    return [];
  }
}

export function decomposeQuery(question: string): string[] {
  const trimmed = question.trim();
  if (!trimmed) return [trimmed];

  // Split on sentence-ending '? ' or connectors ' and ' / ' also '
  const parts = trimmed
    .split(/\?\s+|\s+and\s+|\s+also\s+/i)
    .map((p) => p.trim().replace(/\?$/, '').trim())
    .filter((p) => p.length > 0);

  if (parts.length > 2) {
    // Restore question marks for sub-questions
    return parts.map((p) => (p.endsWith('?') ? p : p + '?'));
  }

  return [trimmed];
}

export async function agenticSearch(
  question: string,
  options?: { maxIterations?: number },
): Promise<AgenticSearchResult> {
  const maxIterations = options?.maxIterations ?? 2;
  const subqueries = decomposeQuery(question);

  let allResults: SearchResult[] = [];
  let answer: string | undefined;
  let iterations = 0;

  // Iteration 1: run all subqueries in parallel
  iterations++;
  const batchResults = await Promise.all(
    subqueries.map((q) => tavilySearch(q, { maxResults: 5 })),
  );

  for (const batch of batchResults) {
    if ((batch as unknown as { _answer?: string })._answer && !answer) {
      answer = (batch as unknown as { _answer: string })._answer;
    }
    allResults.push(...batch);
  }

  // Check if results are weak
  const isWeak =
    allResults.length < 2 || allResults.every((r) => r.score < 0.5);

  if (isWeak && iterations < maxIterations) {
    // Retry with a refined query
    iterations++;
    const suffixes = ['explained', 'tutorial', '2025'];
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    const refined = `${question} ${suffix}`;
    subqueries.push(refined);

    const retryResults = await tavilySearch(refined, {
      maxResults: 5,
      searchDepth: 'advanced',
    });
    if ((retryResults as unknown as { _answer?: string })._answer && !answer) {
      answer = (retryResults as unknown as { _answer: string })._answer;
    }
    allResults.push(...retryResults);
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const r of allResults) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      deduped.push(r);
    }
  }

  // Sort by score descending
  deduped.sort((a, b) => b.score - a.score);

  return { results: deduped, subqueries, iterations, answer };
}
