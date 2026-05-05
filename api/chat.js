import axios from "axios";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const MAX_AGENT_STEPS = Number(process.env.AGENT_MAX_STEPS || 40);
const ALLOWED_TOOLS = ["createDirectory", "writeTextFile", "readTextFile", "listFiles"];

function normalizeRelativeOutputPath(input = "") {
  let value = String(input || "").trim();
  if (!value) return "";

  value = value.replace(/\\/g, "/");
  value = value.replace(/^\/+/, "");
  value = value.replace(/^(\.\/)+/, "");
  value = value.replace(/^Users\/[^/]+\/ai-agents\//i, "");
  value = value.replace(/^\/Users\/[^/]+\/ai-agents\//i, "");

  while (/^generated_sites\//i.test(value)) {
    value = value.replace(/^generated_sites\/+/i, "");
  }
  return value;
}

function buildTranscript(messages) {
  return messages
    .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join("\n\n");
}

async function generateStep(messages) {
  const prompt = `${buildTranscript(messages)}\n\nReturn ONLY valid JSON for your next step.`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: DEFAULT_MODEL,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 60000
        }
      );
      return { text: response?.data?.choices?.[0]?.message?.content || "{}", modelName: DEFAULT_MODEL };
    } catch (error) {
      const status = error?.response?.status;
      if (status !== 429 || attempt === 2) throw error;
      const retryAfterHeader = Number(error?.response?.headers?.["retry-after"]);
      const retryMs = Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : (attempt + 1) * 2500;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  return { text: "{}", modelName: DEFAULT_MODEL };
}

function normalizeToolStep(parsedStep = {}) {
  if (parsedStep.step !== "TOOL") return parsedStep;
  if (!ALLOWED_TOOLS.includes(parsedStep.tool_name)) {
    return {
      step: "THINK",
      content: `Tool '${parsedStep.tool_name}' is invalid. Allowed tools: ${ALLOWED_TOOLS.join(", ")}.`
    };
  }
  return parsedStep;
}

function validateFrontendQuality(fileDrafts = {}) {
  const htmlEntry = Object.entries(fileDrafts).find(([name]) => name.endsWith(".html"));
  const cssEntry = Object.entries(fileDrafts).find(([name]) => name.endsWith(".css"));
  const jsEntry = Object.entries(fileDrafts).find(([name]) => name.endsWith(".js"));
  const html = String(htmlEntry?.[1] || "");
  const css = String(cssEntry?.[1] || "");
  const js = String(jsEntry?.[1] || "");
  const issues = [];

  if (!htmlEntry || !cssEntry || !jsEntry) issues.push("Missing one or more required frontend files (.html, .css, .js).");
  if (html.length < 2000) issues.push("HTML is too short; add complete page structure and real content.");
  if (css.length < 2500) issues.push("CSS is too short; add polished visual design and responsive layout.");
  if (js.length < 500) issues.push("JS is too short; add meaningful interactions.");

  const requiredHtmlHints = ["header", "section", "footer", "main", "nav", "button"];
  for (const hint of requiredHtmlHints) {
    if (!html.toLowerCase().includes(hint)) issues.push(`HTML should include '${hint}'.`);
  }
  const requiredCssHints = ["@media", ":hover", "transition", "flex", "var(", "rem"];
  for (const hint of requiredCssHints) {
    if (!css.toLowerCase().includes(hint)) issues.push(`CSS should include '${hint}' for responsive/polished UI.`);
  }
  if (!js.includes("addEventListener")) issues.push("JS should include 'addEventListener' interaction logic.");
  if (!js.includes("querySelector")) issues.push("JS should include 'querySelector' interaction logic.");
  return { ok: issues.length === 0, issues };
}

function websiteLoopRules() {
  return `
Allowed tool names (exactly these): ${ALLOWED_TOOLS.join(", ")}.
Never use mkdir, fs, shell, node_fs, javascript_fs, or any other unknown tool.
All file paths must be relative (never absolute), e.g.:
createDirectory args: "scaler_clone"
writeTextFile args: {"path":"scaler_clone/index.html","content":"..."}.
For website tasks, complete in <= 10 steps and prioritize:
createDirectory -> writeTextFile(index.html) -> writeTextFile(styles.css) -> writeTextFile(script.js) -> OUTPUT.
Never OUTPUT a minimal scaffold. Write substantial code.
For any frontend website/app request, create a high-quality UI:
- semantic HTML structure with <main>, <nav>, and multiple sections.
- polished responsive CSS with a robust CSS reset, CSS Variables (:root) for color palette and typography, Flexbox/Grid for layout, and relative units (rem/em).
- rich micro-interactions (hover states, active states, focus rings, smooth transitions).
- meaningful JS interactions (e.g. document.querySelector, event listeners).
Before OUTPUT, self-check quality and improve if needed.
`;
}

function buildSystemPrompt() {
  return `
You are an AI coding assistant running in a strict loop.
Always return JSON only:
{"step":"START|THINK|TOOL|OUTPUT","content":"string","tool_name":"string","tool_args":"string or object"}

Rules:
1) Think in multiple steps.
2) Use one TOOL call at a time.
3) Wait for OBSERVE before next action.
4) For website tasks, create: index.html, styles.css, script.js
5) The result must include Header, Hero section, Footer and resemble Scaler Academy style.
6) Use tools only from this list: createDirectory, writeTextFile, readTextFile, listFiles
7) In final OUTPUT, include short completion note.
8) Never use unknown tools.
${websiteLoopRules()}
`;
}

function parseStep(text) {
  try {
    return normalizeToolStep(JSON.parse(text));
  } catch {
    return null;
  }
}

function addObserve(messages, trace, content) {
  const observe = { step: "OBSERVE", content };
  messages.push({ role: "developer", content: JSON.stringify(observe) });
  trace.push(observe);
}

async function runToolStep(parsed, tools, messages, trace) {
  const fn = tools[parsed.tool_name];
  if (!fn) {
    addObserve(messages, trace, `Tool ${parsed.tool_name} not available.`);
    return;
  }
  try {
    const result = await fn(parsed.tool_args);
    addObserve(messages, trace, result);
  } catch (err) {
    addObserve(messages, trace, `Tool error: ${err.message}`);
  }
}

async function runAgent(promptText) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Missing GROQ_API_KEY.");
  }

  const state = { files: {}, directories: new Set() };
  const tools = createVirtualTools(state);
  const trace = [];

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: promptText }
  ];

  for (let i = 0; i < MAX_AGENT_STEPS; i += 1) {
    const { text, modelName } = await generateStep(messages);
    const parsed = parseStep(text);
    if (!parsed) {
      addObserve(messages, trace, "Invalid JSON. Return strict JSON.");
      continue;
    }

    trace.push(parsed);
    messages.push({ role: "assistant", content: JSON.stringify(parsed) });

    if (parsed.step === "START" || parsed.step === "THINK") continue;

    if (parsed.step === "TOOL") {
      await runToolStep(parsed, tools, messages, trace);
      continue;
    }

    if (parsed.step === "OUTPUT") {
      const quality = validateFrontendQuality(state.files);
      if (!quality.ok) {
        addObserve(messages, trace, `Output rejected for low quality. Fix before OUTPUT: ${quality.issues.join(" | ")}`);
        continue;
      }
      return { trace, files: state.files, output: parsed.content, model: modelName };
    }

    addObserve(messages, trace, "Unknown step. Use START, THINK, TOOL, OUTPUT.");
  }

  return { trace, files: state.files, output: `Max iteration reached (${MAX_AGENT_STEPS}).`, model: DEFAULT_MODEL };
}

function createVirtualTools(state) {
  const readPathValue = (input, keys) => {
    if (typeof input === "string") return input;
    if (!input || typeof input !== "object") return "";
    for (const key of keys) {
      if (input[key]) return String(input[key]);
    }
    return "";
  };

  const sanitizePath = (value) => normalizeRelativeOutputPath(value);

  return {
    createDirectory: async (relativeDir = "") => {
      const safe = sanitizePath(readPathValue(relativeDir, ["path", "dir", "folder"]));
      state.directories.add(safe || ".");
      return `Directory created: ${safe || "."}`;
    },
    writeTextFile: async (args = {}) => {
      const relativePath = sanitizePath(readPathValue(args, ["path", "file_path", "file", "filename"]));
      const content = typeof args === "object" ? String(args.content || args.text || args.data || "") : "";
      if (!relativePath) throw new Error("path is required");
      state.files[relativePath] = content;
      return `File written: ${relativePath}`;
    },
    readTextFile: async (relativePath = "") => {
      const safe = sanitizePath(readPathValue(relativePath, ["path", "file"]));
      if (!(safe in state.files)) {
        throw new Error(`File not found: ${safe}`);
      }
      return state.files[safe];
    },
    listFiles: async (relativeDir = "") => {
      const prefix = sanitizePath(readPathValue(relativeDir, ["path", "dir"]));
      return Object.keys(state.files).filter((file) => !prefix || file.startsWith(prefix));
    }
  };
}


export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    const result = await runAgent(prompt);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
