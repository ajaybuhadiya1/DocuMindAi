import express from "express";
import { runRAGQuery, clearSessionHistory } from "../services/chain.js";
import { getIndexStats, clearAllNamespaces, searchDocuments } from "../services/pinecone.js";
import { getActiveDocument, readRegistry, clearRegistry } from "../services/registry.js";
import { generateExecutiveSummary, generateFlashcards, DEFAULT_MODEL } from "../services/gemini.js";

const router = express.Router();

// Query endpoint
router.post("/", async (req, res) => {
  const {
    question,
    sessionId = "default",
    modelName = DEFAULT_MODEL,
    topK = 6,
    temperature = 0.2,
    mode = "document_only",
  } = req.body;

  if (!question?.trim()) {
    return res.status(400).json({ error: "Question is required" });
  }

  const activeDoc = getActiveDocument();

  if (!activeDoc?.namespace) {
    return res.json({
      answer: "No document is currently indexed. Please upload a PDF in the sidebar first.",
      sources: [],
      metrics: null,
      activeDocument: null,
    });
  }

  try {
    const { answer, sourceDocs, metrics } = await runRAGQuery(
      question.trim(),
      activeDoc.namespace,
      sessionId,
      {
        modelName,
        topK: Number(topK) || 6,
        temperature: Number(temperature) || 0.2,
        mode: mode === "hybrid" ? "hybrid" : "document_only",
      }
    );

    const sources = sourceDocs.map((doc) => ({
      source: doc.metadata.source,
      page: doc.metadata.page,
      section: doc.metadata.section || "General",
      score: parseFloat((doc.metadata.score ?? 0).toFixed(3)),
      scorePercent: parseFloat(((doc.metadata.score ?? 0) * 100).toFixed(1)),
      preview: (doc.metadata.childText || doc.pageContent).slice(0, 260) + "...",
      fullText: doc.pageContent,
      childText: doc.metadata.childText || "",
    }));

    res.json({
      answer,
      sources,
      metrics,
      activeDocument: activeDoc,
      modelUsed: modelName,
    });
  } catch (err) {
    console.error("Query error:", err);
    res.status(500).json({ error: err.message || "Query execution failed" });
  }
});

// Summary endpoint
router.post("/summary", async (req, res) => {
  const { modelName = DEFAULT_MODEL } = req.body;
  const activeDoc = getActiveDocument();

  if (!activeDoc?.namespace) {
    return res.status(400).json({ error: "No active document found." });
  }

  try {
    const overviewSearch = await searchDocuments("summary overview introduction findings conclusion", activeDoc.namespace, 10);
    const sampleText = overviewSearch.results.map((r) => r.text).join("\n\n---\n\n");

    const summary = await generateExecutiveSummary(sampleText, modelName);
    res.json({
      success: true,
      summary,
      documentName: activeDoc.filename,
      modelUsed: modelName,
    });
  } catch (err) {
    console.error("Summary error:", err);
    res.status(500).json({ error: err.message || "Failed to generate summary" });
  }
});

// Flashcards endpoint
router.post("/flashcards", async (req, res) => {
  const { modelName = DEFAULT_MODEL } = req.body;
  const activeDoc = getActiveDocument();

  if (!activeDoc?.namespace) {
    return res.status(400).json({ error: "No active document found." });
  }

  try {
    const conceptSearch = await searchDocuments("definitions terminology concepts principles key points", activeDoc.namespace, 10);
    const sampleText = conceptSearch.results.map((r) => r.text).join("\n\n---\n\n");

    const flashcards = await generateFlashcards(sampleText, modelName);
    res.json({
      success: true,
      flashcards,
      documentName: activeDoc.filename,
      modelUsed: modelName,
    });
  } catch (err) {
    console.error("Flashcards error:", err);
    res.status(500).json({ error: err.message || "Failed to generate flashcards" });
  }
});

// Clear session endpoint
router.delete("/session/:sessionId", (req, res) => {
  clearSessionHistory(req.params.sessionId);
  res.json({ success: true, message: "Session history cleared" });
});

// Index stats endpoint
router.get("/stats", async (req, res) => {
  try {
    const [stats, registry] = await Promise.all([
      getIndexStats(),
      Promise.resolve(readRegistry()),
    ]);

    res.json({
      totalVectors: stats.totalRecordCount ?? 0,
      dimension: stats.dimension ?? 768,
      namespaces: stats.namespaces ?? {},
      documents: registry.documents,
      activeId: registry.activeId,
      defaultModel: DEFAULT_MODEL,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Purge database endpoint
router.delete("/clear", async (req, res) => {
  try {
    await clearAllNamespaces();
    clearRegistry();
    res.json({ success: true, message: "All vector databases & namespaces purged" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
