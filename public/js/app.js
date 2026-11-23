// Session
const SESSION_ID = (() => {
  let id = localStorage.getItem("documind_session_id");
  if (!id) {
    id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem("documind_session_id", id);
  }
  return id;
})();

// State
let selectedFile = null;
let isUploading = false;
let isQuerying = false;
let activeDocument = null;
let currentMode = "document_only";

// Query mode
function setQueryMode(mode) {
  currentMode = mode === "hybrid" ? "hybrid" : "document_only";

  const docOnlyBtn = document.getElementById("modeDocOnlyBtn");
  const hybridBtn = document.getElementById("modeHybridBtn");
  const input = document.getElementById("questionInput");

  if (currentMode === "document_only") {
    docOnlyBtn?.classList.add("active");
    hybridBtn?.classList.remove("active");
    if (input) input.placeholder = "Ask anything from the document (summarized from document only)...";
  } else {
    hybridBtn?.classList.add("active");
    docOnlyBtn?.classList.remove("active");
    if (input) input.placeholder = "Ask anything (combines document facts with Gemini knowledge)...";
  }
}

// DOM elements
const dropZone = document.getElementById("dropZone");
const pdfInput = document.getElementById("pdfInput");
const uploadBtn = document.getElementById("uploadBtn");
const uploadBtnText = document.getElementById("uploadBtnText");
const dropTitle = document.getElementById("dropTitle");
const dropSub = document.getElementById("dropSub");
const dropFileInfo = document.getElementById("dropFileInfo");
const fileBadge = document.getElementById("fileBadge");
const progressContainer = document.getElementById("progressContainer");
const progressLabel = document.getElementById("progressLabel");

const activeDocSection = document.getElementById("activeDocSection");
const activeDocName = document.getElementById("activeDocName");
const activeDocMeta = document.getElementById("activeDocMeta");
const headerDocBadge = document.getElementById("headerDocBadge");
const headerDocName = document.getElementById("headerDocName");

const suggestionsSection = document.getElementById("suggestionsSection");
const suggestionsList = document.getElementById("suggestionsList");

const chatArea = document.getElementById("chatArea");
const questionInput = document.getElementById("questionInput");
const sendBtn = document.getElementById("sendBtn");

// Modals
const sourceModal = document.getElementById("sourceModal");
const modalSourceTitle = document.getElementById("modalSourceTitle");
const modalScoreBadge = document.getElementById("modalScoreBadge");
const modalPassageContent = document.getElementById("modalPassageContent");

const insightsModal = document.getElementById("insightsModal");
const insightsModalTitle = document.getElementById("insightsModalTitle");
const insightsModalBody = document.getElementById("insightsModalBody");

// Lifecycle
document.addEventListener("DOMContentLoaded", () => {
  loadDocumentState();
  setupDragDrop();
  setupKeyboard();
  autoResizeTextarea();
});

// Document state
async function loadDocumentState() {
  try {
    const res = await fetch("/api/query/stats");
    const data = await res.json();

    if (data.activeId && data.documents?.length) {
      const doc = data.documents.find((d) => d.id === data.activeId);
      if (doc) setActiveDocument(doc);
    }
  } catch {
    console.log("Status offline");
  }
}

function setActiveDocument(doc) {
  activeDocument = doc;

  if (!doc) {
    activeDocSection.style.display = "none";
    headerDocBadge.style.display = "none";
    return;
  }
  activeDocName.textContent = doc.filename;
  activeDocMeta.textContent = `${doc.pages} pages indexed`;
  activeDocSection.style.display = "block";

  headerDocName.textContent = doc.filename;
  headerDocBadge.style.display = "inline-flex";

  uploadBtnText.textContent = selectedFile ? "Replace Document" : "Change Document";
}

// Drag and drop
function setupDragDrop() {
  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-hover");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-hover");
    });
  });

  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf") {
      setFile(file);
    } else {
      showToast("Please upload a PDF document", "error");
    }
  });

  pdfInput.addEventListener("change", () => {
    if (pdfInput.files[0]) setFile(pdfInput.files[0]);
  });

  uploadBtn.addEventListener("click", (e) => {
    if (!selectedFile) return;
    e.stopPropagation();
    uploadFile();
  });
}

function setFile(file) {
  selectedFile = file;
  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
  fileBadge.textContent = `${file.name} (${sizeMB} MB)`;
  dropTitle.textContent = "File Selected";
  dropSub.style.display = "none";
  dropFileInfo.style.display = "block";
  uploadBtn.disabled = false;
  uploadBtnText.textContent = activeDocument ? "Replace Document" : "Upload Document";
}

// Upload
async function uploadFile() {
  if (!selectedFile || isUploading) return;
  isUploading = true;

  uploadBtn.disabled = true;
  progressContainer.style.display = "flex";
  suggestionsSection.style.display = "none";

  const stages = [
    "Reading document pages...",
    "Extracting clean text & sections...",
    "Indexing knowledge vectors...",
    "Preparing study inquiries with Gemini..."
  ];
  let stageIdx = 0;
  progressLabel.textContent = stages[0];
  const timer = setInterval(() => {
    stageIdx = (stageIdx + 1) % stages.length;
    progressLabel.textContent = stages[stageIdx];
  }, 1800);

  try {
    const formData = new FormData();
    formData.append("pdf", selectedFile);
    formData.append("modelName", "gemini-2.5-flash");

    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();

    clearInterval(timer);
    progressContainer.style.display = "none";

    if (!res.ok) throw new Error(data.error || "Upload failed");

    setActiveDocument({
      id: data.docId,
      filename: selectedFile.name,
      pages: data.pages,
      chunks: data.chunks,
      namespace: data.namespace,
    });

    if (data.suggestedQuestions?.length) {
      renderSuggestions(data.suggestedQuestions);
    }

    showToast("Document is ready!", "success");
    await fetch(`/api/query/session/${SESSION_ID}`, { method: "DELETE" });

    selectedFile = null;
    pdfInput.value = "";
    uploadBtnText.textContent = "Change Document";
    uploadBtn.disabled = false;
  } catch (err) {
    clearInterval(timer);
    progressContainer.style.display = "none";
    showToast(err.message, "error");
    uploadBtnText.textContent = "Try Again";
    uploadBtn.disabled = false;
  } finally {
    isUploading = false;
  }
}

// Suggestions
function renderSuggestions(questions) {
  suggestionsList.innerHTML = "";
  questions.forEach((q) => {
    const btn = document.createElement("button");
    btn.className = "suggestion-btn";
    btn.textContent = q;
    btn.onclick = () => {
      questionInput.value = q;
      autoResizeTextarea();
      sendQuestion();
    };
    suggestionsList.appendChild(btn);
  });
  suggestionsSection.style.display = "block";
}

// Query
function setQuickPrompt(promptText) {
  questionInput.value = promptText;
  autoResizeTextarea();
  sendQuestion();
}

async function sendQuestion() {
  const question = questionInput.value.trim();
  if (!question || isQuerying) return;

  isQuerying = true;
  sendBtn.disabled = true;

  const welcome = document.getElementById("welcomeMessage");
  if (welcome) welcome.style.display = "none";

  appendMessage("user", question);
  questionInput.value = "";
  autoResizeTextarea();

  const loadingElement = appendRunningLoadingCircle(currentMode);
  chatArea.scrollTop = chatArea.scrollHeight;

  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        sessionId: SESSION_ID,
        modelName: "gemini-2.5-flash",
        topK: 6,
        mode: currentMode,
      }),
    });
    const data = await res.json();

    loadingElement.remove();

    if (!res.ok) throw new Error(data.error || "Query failed");

    appendMessage("ai", data.answer, data.sources, currentMode);
  } catch (err) {
    loadingElement.remove();
    appendMessage("ai", `I encountered a problem while looking that up: ${err.message}`);
  } finally {
    isQuerying = false;
    sendBtn.disabled = false;
    chatArea.scrollTop = chatArea.scrollHeight;
  }
}

// Loading indicator
function appendRunningLoadingCircle(mode = "document_only") {
  const row = document.createElement("div");
  row.className = "chat-row chat-row-ai loading-row";

  const initialText = mode === "hybrid"
    ? "Searching document & preparing AI context..."
    : "Reading document passages to summarize data...";

  row.innerHTML = `
    <div class="avatar-badge">AI</div>
    <div class="bubble-box">
      <div class="retrieval-loader">
        <div class="loading-circle-spinner">
          <svg class="spinner-svg" viewBox="0 0 50 50">
            <circle class="spinner-track" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
            <circle class="spinner-head" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
          </svg>
        </div>
        <div class="loading-status-text" id="retrievalStatusLabel">${initialText}</div>
      </div>
    </div>
  `;

  chatArea.appendChild(row);

  const label = row.querySelector("#retrievalStatusLabel");
  const steps = mode === "hybrid"
    ? [
        "Searching document & preparing AI context...",
        "Synthesizing document insights with Gemini...",
        "Crafting comprehensive explanation..."
      ]
    : [
        "Reading document passages to summarize data...",
        "Extracting relevant facts strictly from document...",
        "Composing summarized document answer..."
      ];

  let idx = 0;
  const interval = setInterval(() => {
    if (!row.isConnected) {
      clearInterval(interval);
      return;
    }
    idx = (idx + 1) % steps.length;
    if (label) label.textContent = steps[idx];
  }, 1400);

  return row;
}

// Message rendering
function appendMessage(role, text, sources = [], mode = null) {
  const row = document.createElement("div");
  row.className = `chat-row chat-row-${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar-badge";
  avatar.textContent = role === "user" ? "You" : "AI";

  const bubbleBox = document.createElement("div");
  bubbleBox.className = "bubble-box";

  if (role === "ai") {
    const content = document.createElement("div");
    content.className = "message-content";
    content.innerHTML = formatMarkdown(text);
    bubbleBox.appendChild(content);

    if (sources && sources.length > 0) {
      const sourceList = document.createElement("div");
      sourceList.className = "source-pills-row";

      sources.forEach((s) => {
        const pill = document.createElement("button");
        pill.className = "source-pill";
        pill.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          </svg>
          <span>Page ${s.page || 1}</span>
        `;
        pill.onclick = () => openSourceModal(s);
        sourceList.appendChild(pill);
      });

      bubbleBox.appendChild(sourceList);
    }
  } else {
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = text;
    bubbleBox.appendChild(content);
  }

  row.appendChild(avatar);
  row.appendChild(bubbleBox);
  chatArea.appendChild(row);
  chatArea.scrollTop = chatArea.scrollHeight;
}

// Summary action
async function generateSummaryAction() {
  if (!activeDocument) {
    showToast("Please upload a PDF document first", "error");
    return;
  }

  insightsModalTitle.textContent = `Summary — ${activeDocument.filename}`;
  insightsModalBody.innerHTML = `
    <div class="modal-loading">
      <div class="loading-circle-spinner">
        <svg class="spinner-svg" viewBox="0 0 50 50">
          <circle class="spinner-track" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
          <circle class="spinner-head" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
        </svg>
      </div>
      <p>Generating a structured executive summary...</p>
    </div>
  `;
  insightsModal.classList.add("active");

  try {
    const res = await fetch("/api/query/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: "gemini-2.5-flash" }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Failed to generate summary");

    insightsModalBody.innerHTML = `
      <div class="summary-content">
        ${formatMarkdown(data.summary)}
      </div>
      <div class="modal-footer-action">
        <button class="btn-action-primary" onclick="closeInsightsModal()">Done</button>
      </div>
    `;
  } catch (err) {
    insightsModalBody.innerHTML = `<div class="modal-error">${err.message}</div>`;
  }
}

// Flashcards action
async function generateFlashcardsAction() {
  if (!activeDocument) {
    showToast("Please upload a PDF document first", "error");
    return;
  }

  insightsModalTitle.textContent = `Key Concepts — ${activeDocument.filename}`;
  insightsModalBody.innerHTML = `
    <div class="modal-loading">
      <div class="loading-circle-spinner">
        <svg class="spinner-svg" viewBox="0 0 50 50">
          <circle class="spinner-track" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
          <circle class="spinner-head" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
        </svg>
      </div>
      <p>Extracting core concepts and definitions...</p>
    </div>
  `;
  insightsModal.classList.add("active");

  try {
    const res = await fetch("/api/query/flashcards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: "gemini-2.5-flash" }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Failed to generate flashcards");

    const cards = data.flashcards || [];
    if (!cards.length) {
      insightsModalBody.innerHTML = `<p class="modal-muted">No concepts could be extracted.</p>`;
      return;
    }

    let cardsHtml = `<div class="clean-cards-grid">`;
    cards.forEach((card, idx) => {
      cardsHtml += `
        <div class="clean-card" onclick="this.classList.toggle('revealed')">
          <div class="clean-card-front">
            <span class="card-num">Concept ${idx + 1}</span>
            <div class="card-term">${escapeHtml(card.term)}</div>
            <span class="card-hint">Click to reveal definition</span>
          </div>
          <div class="clean-card-back">
            <div class="card-def">${escapeHtml(card.definition)}</div>
          </div>
        </div>
      `;
    });
    cardsHtml += `</div>`;

    insightsModalBody.innerHTML = cardsHtml;
  } catch (err) {
    insightsModalBody.innerHTML = `<div class="modal-error">${err.message}</div>`;
  }
}

function closeInsightsModal(e) {
  if (e && e.target !== insightsModal && !e.target.classList.contains("btn-modal-close")) return;
  insightsModal.classList.remove("active");
}

// Source modal
function openSourceModal(source) {
  modalSourceTitle.textContent = `${source.source || "Document"}`;
  modalScoreBadge.textContent = `Page ${source.page || 1}`;

  const fullText = source.fullText || source.preview || "";
  const snippet = (source.childText || "").trim();

  let highlightedHtml = escapeHtml(fullText);
  if (snippet && snippet.length > 15) {
    const escapedSnippet = escapeRegex(snippet.slice(0, 100));
    const reg = new RegExp(`(${escapedSnippet})`, "i");
    highlightedHtml = highlightedHtml.replace(reg, `<mark class="snippet-highlight">$1</mark>`);
  }

  modalPassageContent.innerHTML = highlightedHtml;
  sourceModal.classList.add("active");
}

function closeSourceModal(e) {
  if (e && e.target !== sourceModal && !e.target.classList.contains("btn-modal-close")) return;
  sourceModal.classList.remove("active");
}

// Clear chat
async function clearChat() {
  try {
    await fetch(`/api/query/session/${SESSION_ID}`, { method: "DELETE" });
  } catch (e) {}

  chatArea.innerHTML = "";
  const welcome = document.getElementById("welcomeMessage");
  if (welcome) {
    welcome.style.display = "flex";
    chatArea.appendChild(welcome);
  }
}

// Reset document
async function clearIndex() {
  if (!confirm("Remove this document from memory?")) return;

  try {
    await fetch("/api/query/clear", { method: "DELETE" });
    setActiveDocument(null);
    suggestionsSection.style.display = "none";
    clearChat();
    showToast("Document removed", "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Utilities
function setupKeyboard() {
  questionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuestion();
    }
  });
}

function autoResizeTextarea() {
  questionInput.addEventListener("input", () => {
    questionInput.style.height = "auto";
    questionInput.style.height = `${Math.min(questionInput.scrollHeight, 140)}px`;
  });
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast-item toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Markdown parser
function formatMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="md-h1">$1</h1>');

  // Bold & Italic
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

  // Code
  html = html.replace(/```([\s\S]*?)```/gim, '<pre class="md-pre"><code>$1</code></pre>');
  html = html.replace(/`([^`]+)`/gim, '<code class="md-code">$1</code>');

  // Lists
  html = html.replace(/^\s*[-*+]\s+(.*$)/gim, '<li class="md-li">$1</li>');
  html = html.replace(/(<li class="md-li">.*<\/li>)/gms, '<ul class="md-ul">$1</ul>');

  // Paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, '');

  return html;
}
