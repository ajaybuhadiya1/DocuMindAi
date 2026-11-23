import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { buildParentChildChunks } from "../services/chunker.js";
import { upsertDocuments, deleteNamespace, getIndexStats } from "../services/pinecone.js";
import { generateSuggestedQuestions, DEFAULT_MODEL } from "../services/gemini.js";
import {
  readRegistry,
  registerDocument,
  removeDocument,
} from "../services/registry.js";

const router = express.Router();

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    file.mimetype === "application/pdf"
      ? cb(null, true)
      : cb(new Error("Only PDF files are allowed"));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Upload and process PDF
router.post("/", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No PDF file provided" });
  }

  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const modelName = req.body.modelName || DEFAULT_MODEL;

  try {
    // Purge previous documents
    const registry = readRegistry();
    const oldDocs = registry.documents;

    if (oldDocs.length > 0) {
      console.log(`Purging ${oldDocs.length} old document namespace(s)...`);
      await Promise.all(oldDocs.map((doc) => deleteNamespace(doc.namespace)));
      oldDocs.forEach((doc) => removeDocument(doc.id));
    }

    // Load PDF
    const loader = new PDFLoader(filePath);
    const rawDocs = await loader.load();
    console.log(`Loaded PDF: ${fileName} — ${rawDocs.length} pages`);

    // Chunking
    const docId = `doc-${Date.now()}`;
    const namespace = docId;

    const { childRecords, parentCount, childCount, stats } =
      await buildParentChildChunks(rawDocs, fileName, docId);

    console.log(
      `Chunking complete: ${parentCount} parents → ${childCount} children` +
      ` (avg child: ${stats.avgChildLength} chars, estimated tokens: ${stats.estimatedTokens})`
    );

    // Upsert to Pinecone
    console.log(`Upserting ${childCount} vectors to namespace "${namespace}"...`);
    await upsertDocuments(childRecords, namespace);
    console.log("Upsert complete.");

    // Register active document
    registerDocument({
      id: docId,
      filename: fileName,
      namespace,
      pages: rawDocs.length,
      chunks: childCount,
      parents: parentCount,
      avgChildLength: stats.avgChildLength,
      estimatedTokens: stats.estimatedTokens,
      uploadedAt: new Date().toISOString(),
    });

    // Suggested questions
    const sampleText = childRecords
      .slice(0, 10)
      .map((r) => r.parentText)
      .join("\n\n");
    const suggestedQuestions = await generateSuggestedQuestions(sampleText, modelName);

    // Index stats
    const indexStats = await getIndexStats();

    // Clean temp file
    fs.unlink(filePath, () => {});

    res.json({
      success: true,
      message: `Indexed "${fileName}" with Structure-Aware Chunker`,
      docId,
      namespace,
      pages: rawDocs.length,
      chunks: childCount,
      parents: parentCount,
      totalVectors: indexStats.totalRecordCount ?? childCount,
      suggestedQuestions,
      chunkingStrategy: "structure-aware-parent-child",
      stats,
      documents: readRegistry().documents,
    });
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// List documents
router.get("/documents", (req, res) => {
  const { documents, activeId } = readRegistry();
  res.json({ documents, activeId });
});

// Delete document
router.delete("/documents/:id", async (req, res) => {
  const { id } = req.params;
  const registry = readRegistry();
  const doc = registry.documents.find((d) => d.id === id);

  if (!doc) {
    return res.status(404).json({ error: "Document not found" });
  }

  try {
    await deleteNamespace(doc.namespace);
    removeDocument(id);
    res.json({ success: true, message: `Removed "${doc.filename}"` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
