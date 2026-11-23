import * as dotenv from "dotenv";
dotenv.config();

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser, StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";

// Config
export const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
export const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

const llmCache = new Map();

// LLM instance
export function getLLM(modelName = DEFAULT_MODEL, temperature = 0.2) {
  const key = `${modelName}:${temperature}`;
  if (!llmCache.has(key)) {
    const instance = new ChatGoogleGenerativeAI({
      model: modelName,
      apiKey: process.env.GEMINI_API_KEY,
      temperature,
    });
    llmCache.set(key, instance);
  }
  return llmCache.get(key);
}

// Fallback invoker
export async function invokeWithFallback(prompt, parser, input, primaryModel = DEFAULT_MODEL, temperature = 0.2) {
  const modelsToTry = [primaryModel, ...FALLBACK_MODELS.filter(m => m !== primaryModel)];
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const llm = getLLM(model, temperature);
      const chain = RunnableSequence.from([prompt, llm, parser]);
      const result = await chain.invoke(input);
      return { result, modelUsed: model };
    } catch (err) {
      console.warn(`Model ${model} failed (${err.message}). Trying fallback...`);
      lastError = err;
    }
  }

  throw lastError || new Error("All Gemini models failed");
}

// Suggested questions
const questionsPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are an educational AI. Based on the document content provided, generate exactly 5 insightful, high-value study questions.
Return your response as a valid JSON array of 5 strings ONLY. No explanation, no markdown, no extra text.
Example format: ["Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?"]`,
  ],
  [
    "human",
    `Generate 5 insightful questions for this document:\n\n{sampleText}`,
  ],
]);

const questionsParser = new JsonOutputParser();

export async function generateSuggestedQuestions(sampleText, modelName = DEFAULT_MODEL) {
  try {
    const { result } = await invokeWithFallback(
      questionsPrompt,
      questionsParser,
      { sampleText: sampleText.slice(0, 6000) },
      modelName,
      0.3
    );

    if (Array.isArray(result) && result.every((q) => typeof q === "string")) {
      return result.slice(0, 5);
    }
    return [];
  } catch (err) {
    console.error("generateSuggestedQuestions error:", err.message);
    return [
      "What is the main topic or objective of this document?",
      "What are the key methodologies or concepts presented?",
      "What notable results, findings, or metrics are discussed?",
      "What conclusions or actionable takeaways are highlighted?",
      "How do the core ideas in this document apply in practice?"
    ];
  }
}

// Executive summary
const summaryPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a top-tier research analyst. Provide a structured, high-impact Executive Summary of the document text.
Format your response in beautiful Markdown:
- **Core Objective & Overview**: 2-3 sentences summarizing the purpose.
- **Key Takeaways & Findings**: 4-6 bullet points with bold highlights.
- **Critical Insights & Metrics**: Notable data, conclusions, or methodologies.
- **Actionable Next Steps**: Practical implications.
Be concise, clear, and highly factual.`,
  ],
  [
    "human",
    `Document Excerpts:\n\n{sampleText}`,
  ],
]);

export async function generateExecutiveSummary(sampleText, modelName = DEFAULT_MODEL) {
  try {
    const { result } = await invokeWithFallback(
      summaryPrompt,
      new StringOutputParser(),
      { sampleText: sampleText.slice(0, 10000) },
      modelName,
      0.2
    );
    return result;
  } catch (err) {
    console.error("generateExecutiveSummary error:", err.message);
    throw new Error(`Summary generation failed: ${err.message}`);
  }
}

// Flashcards
const flashcardsPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are an expert tutor. Extract 6 essential concepts or key terms from the document text and turn them into study flashcards.
Return your response as a valid JSON array of objects with "term" and "definition" keys ONLY.
Example: [{"term": "Concept Name", "definition": "Clear, concise definition and significance."}]
No markdown fences, no preamble, valid JSON array only.`,
  ],
  [
    "human",
    `Document Excerpts:\n\n{sampleText}`,
  ],
]);

const flashcardsParser = new JsonOutputParser();

export async function generateFlashcards(sampleText, modelName = DEFAULT_MODEL) {
  try {
    const { result } = await invokeWithFallback(
      flashcardsPrompt,
      flashcardsParser,
      { sampleText: sampleText.slice(0, 8000) },
      modelName,
      0.3
    );
    if (Array.isArray(result)) return result.slice(0, 6);
    return [];
  } catch (err) {
    console.error("generateFlashcards error:", err.message);
    return [];
  }
}

