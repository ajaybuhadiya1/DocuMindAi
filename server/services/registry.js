import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "../data/registry.json");

const DEFAULT_REGISTRY = { activeId: null, documents: [] };

// Read
export function readRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return { ...DEFAULT_REGISTRY };
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return { ...DEFAULT_REGISTRY };
  }
}

// Write
function writeRegistry(data) {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// Active document
export function getActiveDocument() {
  const reg = readRegistry();
  if (!reg.activeId) return null;
  return reg.documents.find((d) => d.id === reg.activeId) ?? null;
}

// Register document
export function registerDocument({ id, filename, namespace, pages, chunks, uploadedAt }) {
  const reg = readRegistry();

  reg.documents = reg.documents.filter((d) => d.filename !== filename);
  reg.documents.push({ id, filename, namespace, pages, chunks, uploadedAt });
  reg.activeId = id;

  writeRegistry(reg);
}

// Remove document
export function removeDocument(id) {
  const reg = readRegistry();
  reg.documents = reg.documents.filter((d) => d.id !== id);
  if (reg.activeId === id) {
    reg.activeId = reg.documents[reg.documents.length - 1]?.id ?? null;
  }
  writeRegistry(reg);
}

// Clear registry
export function clearRegistry() {
  writeRegistry({ ...DEFAULT_REGISTRY });
}
