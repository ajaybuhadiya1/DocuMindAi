import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// Separators
const SENTENCE_SEPARATORS = [
  "\n\n\n",
  "\n\n",
  ".\n",
  ". ",
  "! ",
  "? ",
  ";\n",
  "; ",
  ":\n",
  ",\n",
  "\n",
  " ",
  "",
];

// Splitters
const parentSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1500,
  chunkOverlap: 180,
  separators: SENTENCE_SEPARATORS,
});

const childSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 380,
  chunkOverlap: 50,
  separators: SENTENCE_SEPARATORS,
});

// Section detector
const HEADING_REGEX = /^(?:#{1,6}\s+|(?:\d+\.)+\d*\s+|[A-Z0-9\s]{4,40}:?$|CHAPTER\s+\d+|SECTION\s+\d+|PART\s+\d+|ABSTRACT|INTRODUCTION|CONCLUSION|SUMMARY|OVERVIEW|BACKGROUND|METHODOLOGY|RESULTS|DISCUSSION|REFERENCES)/i;

function extractActiveSection(text, fallback = "General") {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 4 && trimmed.length <= 60 && HEADING_REGEX.test(trimmed)) {
      return trimmed.replace(/^#+\s*/, "").replace(/[:\.\-_]+$/, "").trim();
    }
  }
  return fallback;
}

// Text cleaner
function cleanDocumentText(text) {
  if (!text || typeof text !== "string") return "";

  return (
    text
      .replace(/(\b\w+)-\s*\n\s*(\w+\b)/g, "$1$2")
      .replace(/^\s*[-–—]?\s*\d+\s*[-–—]?\s*$/gm, "")
      .replace(/[-_=*~]{4,}/g, "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u00A0/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim()
  );
}

// Parent-child chunk builder
export async function buildParentChildChunks(rawDocs, fileName, docId) {
  const childRecords = [];
  let parentCount = 0;
  let currentSection = "Introduction";
  let totalParentChars = 0;
  let totalChildChars = 0;

  for (let pageIdx = 0; pageIdx < rawDocs.length; pageIdx++) {
    const rawDoc = rawDocs[pageIdx];
    const pageNum = rawDoc.metadata?.loc?.pageNumber ?? rawDoc.metadata?.page ?? (pageIdx + 1);
    const cleanedPageText = cleanDocumentText(rawDoc.pageContent);

    if (!cleanedPageText || cleanedPageText.length < 25) continue;

    currentSection = extractActiveSection(cleanedPageText, currentSection);

    const pageParents = await parentSplitter.splitText(cleanedPageText);

    for (const rawParentText of pageParents) {
      const parentTrimmed = rawParentText.trim();
      if (!parentTrimmed || parentTrimmed.length < 30) continue;

      const parentId = `${docId}-p${parentCount}`;
      parentCount++;
      totalParentChars += parentTrimmed.length;

      const contextPrefix = `[Source: ${fileName} | Page: ${pageNum} | Section: ${currentSection}]`;
      const enrichedParentText = `${contextPrefix}\n${parentTrimmed}`;

      const rawChildTexts = await childSplitter.splitText(parentTrimmed);

      for (let ci = 0; ci < rawChildTexts.length; ci++) {
        const childTrimmed = rawChildTexts[ci].trim();
        if (!childTrimmed || childTrimmed.length < 15) continue;

        totalChildChars += childTrimmed.length;

        const childTextWithContext = `${contextPrefix}\n${childTrimmed}`;

        childRecords.push({
          id: `${parentId}-c${ci}`,
          text: childTextWithContext,
          childSnippet: childTrimmed,
          parentText: enrichedParentText,
          parentId,
          source: fileName,
          page: pageNum,
          section: currentSection,
        });
      }
    }
  }

  const childCount = childRecords.length;
  const avgChildLength = childCount ? Math.round(totalChildChars / childCount) : 0;
  const avgParentLength = parentCount ? Math.round(totalParentChars / (parentCount || 1)) : 0;
  const estimatedTokens = Math.round(totalChildChars / 4);

  return {
    childRecords,
    parentCount,
    childCount,
    stats: {
      avgChildLength,
      avgParentLength,
      totalPages: rawDocs.length,
      estimatedTokens,
    },
  };
}
