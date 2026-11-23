import * as dotenv from "dotenv";
dotenv.config();

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { Document } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";
import { searchDocuments } from "./pinecone.js";
import { getLLM, DEFAULT_MODEL, invokeWithFallback } from "./gemini.js";

// Session store
const sessionStore = new Map();

export function getSessionHistory(sessionId) {
  if (!sessionStore.has(sessionId)) sessionStore.set(sessionId, []);
  return sessionStore.get(sessionId);
}

export function clearSessionHistory(sessionId) {
  sessionStore.delete(sessionId);
}

function formatHistoryAsText(history) {
  if (!history.length) return "No previous conversation.";
  return history
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Human" : "AI"}: ${m.content}`)
    .join("\n");
}

// Query rewriter
const queryRewritePrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a query rewriting expert. Based on the provided chat history, rephrase the "Follow Up Question" into a complete, standalone question that can be fully understood without the chat history.
Only output the rewritten question and nothing else. Do NOT explain. Do NOT add quotes.
If the question is already standalone or independent, return it exactly as-is.`,
  ],
  [
    "human",
    `Chat History:
{chatHistory}

Follow Up Question: {question}

Standalone Question:`,
  ],
]);

async function rewriteQuery(question, history, modelName = DEFAULT_MODEL) {
  const start = Date.now();
  if (!history || !history.length) {
    return {
      standaloneQuestion: question,
      wasRewritten: false,
      rewriteMs: 0,
    };
  }

  const pronounRegex = /\b(it|this|that|these|those|they|them|he|she|above|previous|earlier)\b/i;
  if (question.length > 40 && !pronounRegex.test(question)) {
    return {
      standaloneQuestion: question,
      wasRewritten: false,
      rewriteMs: 0,
    };
  }

  try {
    const llm = getLLM(modelName, 0.1);
    const chain = RunnableSequence.from([
      queryRewritePrompt,
      llm,
      new StringOutputParser(),
    ]);

    const chatHistory = formatHistoryAsText(history);
    const rewritten = await chain.invoke({ chatHistory, question });
    const clean = rewritten.trim();
    const wasRewritten = clean.toLowerCase() !== question.trim().toLowerCase();

    return {
      standaloneQuestion: clean,
      wasRewritten,
      rewriteMs: Date.now() - start,
    };
  } catch (err) {
    console.warn("Query rewrite fallback:", err.message);
    return {
      standaloneQuestion: question,
      wasRewritten: false,
      rewriteMs: Date.now() - start,
    };
  }
}

// Pinecone retriever
export class PineconeNamespaceRetriever extends BaseRetriever {
  lc_namespace = ["rag_app", "retrievers", "pinecone_namespace"];

  constructor(namespace, topK = 6) {
    super();
    this.namespace = namespace;
    this.topK = topK;
  }

  async _getRelevantDocuments(query) {
    const searchResponse = await searchDocuments(query, this.namespace, this.topK);
    this._lastRetrievalMeta = {
      fromCache: searchResponse.fromCache,
      retrievalMs: searchResponse.retrievalMs,
    };

    return searchResponse.results.map(
      (r) =>
        new Document({
          pageContent: r.text,
          metadata: {
            source: r.source,
            page: r.page,
            section: r.section || "General",
            score: r.score,
            childText: r.childText,
            rawDenseScore: r.rawDenseScore,
          },
        })
    );
  }
}

// Metrics engine
function computeMetrics(docs, standaloneQuestion, originalQuestion, wasRewritten, timing = {}) {
  const scores = docs.map((d) => d.metadata.score ?? 0);
  const avg = scores.length
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0;

  return {
    chunksRetrieved: docs.length,
    avgSimilarityScore: parseFloat((avg * 100).toFixed(1)),
    maxSimilarityScore: parseFloat((Math.max(...scores, 0) * 100).toFixed(1)),
    minSimilarityScore: parseFloat((Math.min(...scores, 1) * 100).toFixed(1)),
    queryRewritten: wasRewritten,
    standaloneQuestion: wasRewritten ? standaloneQuestion : null,
    originalQuestion: wasRewritten ? originalQuestion : null,
    timing: {
      rewriteMs: timing.rewriteMs || 0,
      retrievalMs: timing.retrievalMs || 0,
      generationMs: timing.generationMs || 0,
      totalMs: timing.totalMs || 0,
      cachedRetrieval: !!timing.fromCache,
    },
    modelUsed: timing.modelName || DEFAULT_MODEL,
    mode: timing.mode || "document_only",
  };
}

// Prompt templates
const DOCUMENT_ONLY_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a knowledgeable and articulate document assistant. Your role is to provide a complete, comprehensive, and well-summarized answer based EXCLUSIVELY on the provided document excerpts.

Rules:
1. Provide a thorough, well-explained summary and full data on what the document states about the user's question.
2. Do NOT mention page numbers, citations, or references like "(Page X)" or "On page Y" in your answer text. Focus purely on explaining the actual facts, concepts, and details thoroughly.
3. Base your answer strictly on the provided context. Do not speculate or invent outside information.
4. If the document does not contain the answer, state clearly: "I could not find information about this in the uploaded document."
5. Format your response cleanly with clear paragraphs, bold key terms, and bullet points where helpful for readability.

DOCUMENT CONTEXT:
{context}`,
  ],
  ["human", "{question}"],
]);

const HYBRID_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are an expert AI knowledge assistant. Your goal is to provide a rich, complete explanation by combining facts from the uploaded document with your broader general AI knowledge.

Instructions:
1. **From the Document**: Thoroughly explain everything the uploaded document covers regarding the user's question.
2. **Broader Context & AI Knowledge**: Expand on the topic with definitions, real-world examples, practical implications, or related concepts to provide a complete and deep understanding.
3. **Organization**: Structure your answer cleanly with headers, bold highlights, and bullet points so the user can easily digest both the document facts and the broader context.

DOCUMENT CONTEXT:
{context}`,
  ],
  ["human", "{question}"],
]);

function formatDocsAsContext(docs) {
  if (!docs || !docs.length) return "No relevant document passages found.";

  return docs
    .map(
      (doc, i) =>
        `[Passage ${i + 1} | ${doc.metadata.source} | Page ${doc.metadata.page} | Section: ${doc.metadata.section} | Match: ${(doc.metadata.score * 100).toFixed(1)}%]\n${doc.pageContent}`
    )
    .join("\n\n---\n\n");
}

// Main RAG pipeline
export async function runRAGQuery(
  question,
  namespace,
  sessionId = "default",
  options = {}
) {
  const totalStart = Date.now();
  const modelName = options.modelName || DEFAULT_MODEL;
  const topK = options.topK || 6;
  const temperature = options.temperature ?? 0.2;
  const mode = options.mode === "hybrid" ? "hybrid" : "document_only";

  const history = getSessionHistory(sessionId);

  const { standaloneQuestion, wasRewritten, rewriteMs } = await rewriteQuery(
    question,
    history,
    modelName
  );

  const retriever = new PineconeNamespaceRetriever(namespace, topK);
  const sourceDocs = await retriever.invoke(standaloneQuestion);
  const retrievalMs = retriever._lastRetrievalMeta?.retrievalMs || 0;
  const fromCache = retriever._lastRetrievalMeta?.fromCache || false;

  const activePrompt = mode === "hybrid" ? HYBRID_PROMPT : DOCUMENT_ONLY_PROMPT;

  const genStart = Date.now();
  const context = formatDocsAsContext(sourceDocs);
  
  const { result: answer, modelUsed } = await invokeWithFallback(
    activePrompt,
    new StringOutputParser(),
    { context, question: standaloneQuestion },
    modelName,
    temperature
  );

  const generationMs = Date.now() - genStart;
  const totalMs = Date.now() - totalStart;

  history.push({ role: "user", content: question });
  history.push({ role: "assistant", content: answer });
  if (history.length > 20) history.splice(0, history.length - 20);

  const metrics = computeMetrics(sourceDocs, standaloneQuestion, question, wasRewritten, {
    rewriteMs,
    retrievalMs,
    generationMs,
    totalMs,
    fromCache,
    modelName,
    mode,
  });

  return { answer, sourceDocs, metrics };
}
