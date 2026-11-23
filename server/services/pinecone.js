import { Pinecone } from "@pinecone-database/pinecone";
import * as dotenv from "dotenv";
dotenv.config();

const BATCH_SIZE = 50;

let _client = null;

// Client
function getClient() {
  if (!_client) _client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  return _client;
}

// Index
function getIndex() {
  return getClient().Index(process.env.PINECONE_INDEX_NAME);
}

// Search cache
const searchCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_SIZE = 250;

function getCacheKey(namespace, query, topK) {
  return `${namespace}:${topK}:${query.trim().toLowerCase()}`;
}

export function clearSearchCache(namespace) {
  if (namespace) {
    for (const key of searchCache.keys()) {
      if (key.startsWith(`${namespace}:`)) searchCache.delete(key);
    }
  } else {
    searchCache.clear();
  }
}

// Hybrid score booster
function computeHybridScore(denseScore, query, text, section = "") {
  if (!query || !text) return denseScore;

  const queryTerms = query.toLowerCase().match(/\b\w{3,}\b/g) || [];
  if (!queryTerms.length) return denseScore;

  const textLower = text.toLowerCase();
  const sectionLower = (section || "").toLowerCase();

  let matches = 0;
  let exactPhraseBonus = 0;

  if (query.length > 5 && textLower.includes(query.toLowerCase())) {
    exactPhraseBonus = 0.12;
  }

  for (const term of queryTerms) {
    if (textLower.includes(term)) matches++;
    if (sectionLower.includes(term)) matches += 0.5;
  }

  const termMatchRatio = matches / (queryTerms.length || 1);
  const keywordBoost = Math.min(termMatchRatio * 0.15 + exactPhraseBonus, 0.25);

  return Math.min(1.0, denseScore * 0.85 + keywordBoost);
}

// Upsert documents
export async function upsertDocuments(records, namespace, onProgress) {
  const ns = getIndex().namespace(namespace);
  clearSearchCache(namespace);

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE).map((r) => ({
      _id: r.id,
      text: r.text,
      childSnippet: r.childSnippet ?? r.text,
      parentText: r.parentText ?? r.text,
      parentId: r.parentId ?? r.id,
      source: r.source,
      page: r.page,
      section: r.section || "General",
    }));

    await ns.upsertRecords(batch);
    onProgress?.(Math.min(i + BATCH_SIZE, records.length), records.length);
  }
}

// Search documents
export async function searchDocuments(query, namespace, topK = 6) {
  const startTime = Date.now();
  const cacheKey = getCacheKey(namespace, query, topK);

  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return {
      results: cached.results,
      fromCache: true,
      retrievalMs: Date.now() - startTime,
    };
  }

  const ns = getIndex().namespace(namespace);
  const fetchTopK = Math.max(topK * 2, 10);

  const rawResults = await ns.searchRecords({
    query: {
      inputs: { text: query },
      topK: fetchTopK,
    },
    fields: ["text", "childSnippet", "parentText", "parentId", "source", "page", "section"],
  });

  const hits = rawResults?.result?.hits ?? rawResults?.matches ?? [];
  const seenParents = new Map();

  for (const hit of hits) {
    const pid = hit.fields?.parentId ?? hit._id;
    const denseScore = hit._score ?? 0;
    const parentText = hit.fields?.parentText ?? hit.fields?.text ?? "";
    const childText = hit.fields?.childSnippet ?? hit.fields?.text ?? "";
    const section = hit.fields?.section ?? "";

    const hybridScore = computeHybridScore(denseScore, query, parentText + " " + childText, section);

    if (!seenParents.has(pid) || seenParents.get(pid).score < hybridScore) {
      seenParents.set(pid, {
        text: parentText,
        childText: childText,
        source: hit.fields?.source ?? "",
        page: hit.fields?.page ?? 0,
        section: section,
        score: hybridScore,
        rawDenseScore: denseScore,
      });
    }
  }

  const sorted = Array.from(seenParents.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (searchCache.size >= MAX_CACHE_SIZE) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
  searchCache.set(cacheKey, { results: sorted, timestamp: Date.now() });

  return {
    results: sorted,
    fromCache: false,
    retrievalMs: Date.now() - startTime,
  };
}

// Namespace management
export async function deleteNamespace(namespace) {
  clearSearchCache(namespace);
  const ns = getIndex().namespace(namespace);
  await ns.deleteAll();
}

export async function clearAllNamespaces() {
  clearSearchCache();
  await getIndex().deleteAll();
}

export async function getIndexStats() {
  return await getIndex().describeIndexStats();
}
