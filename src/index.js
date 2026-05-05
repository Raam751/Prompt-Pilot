import dotenv from "dotenv";
import axios from "axios";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execAsync = promisify(exec);
dotenv.config();
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const PROJECT_ROOT = process.cwd();
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "generated_sites");
const DEFAULT_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const MAX_AGENT_STEPS = Number(process.env.AGENT_MAX_STEPS || 40);
const ALLOWED_TOOLS = [
  "createDirectory",
  "writeTextFile",
  "readTextFile",
  "listFiles",
  "getTheWeatherOfCity",
  "getGithubDetailsAboutUser",
  "executeCommand"
];

function normalizeRelativeOutputPath(input = "") {
  let value = String(input || "").trim();
  if (!value) return "";

  value = value.replace(/\\/g, "/");
  value = value.replace(/^\/+/, "");
  value = value.replace(/^(\.\/)+/, "");

  // Strip common absolute-prefix fragments if model emits them.
  value = value.replace(/^Users\/[^/]+\/ai-agents\//i, "");
  value = value.replace(/^\/Users\/[^/]+\/ai-agents\//i, "");

  // Remove repeated generated_sites prefixes.
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

async function generateAgentStep(messages) {
  const prompt = `${buildTranscript(messages)}\n\nReturn ONLY valid JSON for your next step.`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: DEFAULT_MODEL,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 60000
        }
      );
      return response?.data?.choices?.[0]?.message?.content || "{}";
    } catch (error) {
      const status = error?.response?.status;
      if (status !== 429 || attempt === 2) throw error;
      const retryAfterHeader = Number(error?.response?.headers?.["retry-after"]);
      const retryMs = Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : (attempt + 1) * 2500;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  return "{}";
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

  if (!htmlEntry || !cssEntry || !jsEntry) {
    issues.push("Missing one or more required frontend files (.html, .css, .js).");
  }
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
  const requiredJsHints = ["addEventListener", "querySelector"];
  for (const hint of requiredJsHints) {
    if (!js.includes(hint)) {
      issues.push(`JS should include '${hint}' interaction logic.`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function ensureWebsitePromptRules() {
  return `
Allowed tool names (exactly these): ${ALLOWED_TOOLS.join(", ")}.
Do not invent tool names like mkdir, fs, shell, node_fs, or javascript_fs.
All paths must be relative to generated_sites (never absolute), e.g.:
- createDirectory args: "scaler_clone"
- writeTextFile args: {"path":"scaler_clone/index.html","content":"..."}
For website tasks, do at most 10 total steps and prioritize:
1) createDirectory
2) writeTextFile for index.html
3) writeTextFile for styles.css
4) writeTextFile for script.js
5) OUTPUT
Never OUTPUT a minimal scaffold. Write substantial code.
If the user asks for a specific site style/brand, mirror visual style but keep content original.
For every frontend task (any website/app page), produce:
- semantic HTML structure with <main>, <nav>, and multiple sections.
- polished responsive CSS with a robust CSS reset, CSS Variables (:root) for color palette and typography, Flexbox/Grid for layout, and relative units (rem/em).
- rich micro-interactions (hover states, active states, focus rings, smooth transitions).
- JS interactions (e.g. document.querySelector, event listeners for menu toggle, smooth scroll, or CTA behavior).
Before OUTPUT, self-check quality. If too basic, rewrite files with richer UI.
`;
}

const systemPrompt = `
You are an AI coding assistant running in a CLI loop.
You MUST strictly reply with JSON only:
{
  "step":"START|THINK|TOOL|OUTPUT",
  "content":"string",
  "tool_name":"string",
  "tool_args":"string or object"
}

Rules:
1) Always think in multiple steps before OUTPUT.
2) Use exactly one TOOL call per assistant turn.
3) Wait for OBSERVE before next action.
4) If task is website generation, generate these files:
   - index.html
   - styles.css
   - script.js
5) The website must have Header, Hero section, and Footer and resemble Scaler Academy style.
6) Use modern semantic HTML/CSS/JS and ensure index.html links CSS+JS correctly.
7) Keep generated website in a dedicated folder inside generated_sites.
8) When complete, OUTPUT must include final folder path and list of created files.
9) Never use unknown tools.
${ensureWebsitePromptRules()}
`;

async function runAgentLoop(userInstruction) {
  const fileDrafts = {};
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userInstruction }
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    const raw = await generateAgentStep(messages);
    let parsed;
    try {
      parsed = normalizeToolStep(JSON.parse(raw));
    } catch {
      messages.push({
        role: "developer",
        content: JSON.stringify({
          step: "OBSERVE",
          content: "Invalid JSON from assistant. Return strict JSON only."
        })
      });
      continue;
    }

    messages.push({ role: "assistant", content: JSON.stringify(parsed) });

    if (parsed.step === "START" || parsed.step === "THINK") {
      console.log(`[${parsed.step}] ${parsed.content}`);
      continue;
    }

    if (parsed.step === "TOOL") {
      console.log(`[TOOL] ${parsed.tool_name}`);
      const toolFn = toolMap[parsed.tool_name];
      if (!toolFn) {
        messages.push({
          role: "developer",
          content: JSON.stringify({
            step: "OBSERVE",
            content: `Tool ${parsed.tool_name} is not available.`
          })
        });
        continue;
      }

      try {
        const result = await toolFn(parsed.tool_args);
        if (parsed.tool_name === "writeTextFile") {
          const args = typeof parsed.tool_args === "string" ? { path: parsed.tool_args, content: "" } : parsed.tool_args || {};
          const rawPath = args.path || args.file_path || args.file || args.filename || "";
          const normalizedPath = normalizeRelativeOutputPath(rawPath);
          fileDrafts[normalizedPath] = String(args.content || args.text || args.data || "");
        }
        messages.push({
          role: "developer",
          content: JSON.stringify({ step: "OBSERVE", content: result })
        });
      } catch (error) {
        messages.push({
          role: "developer",
          content: JSON.stringify({
            step: "OBSERVE",
            content: `Tool error: ${error.message}`
          })
        });
      }
      continue;
    }

    if (parsed.step === "OUTPUT") {
      const quality = validateFrontendQuality(fileDrafts);
      if (!quality.ok) {
        messages.push({
          role: "developer",
          content: JSON.stringify({
            step: "OBSERVE",
            content: `Output rejected for low quality. Fix these issues before OUTPUT: ${quality.issues.join(" | ")}`
          })
        });
        continue;
      }
      console.log(`[OUTPUT] ${parsed.content}`);
      return parsed.content;
    }

    messages.push({
      role: "developer",
      content: JSON.stringify({
        step: "OBSERVE",
        content: "Unknown step; choose START, THINK, TOOL or OUTPUT."
      })
    });
  }
  throw new Error(`Agent exceeded max step limit (${MAX_AGENT_STEPS}). Try a shorter prompt.`);
}

async function ensureOutputRoot() {
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
}

async function getTheWeatherOfCity(cityname = "") {
  const url = `https://wttr.in/${cityname.toLowerCase()}?format=%C+%t`;
  const { data } = await axios.get(url, { responseType: "text" });
  return `The weather of ${cityname} is ${data}`;
}

async function getGithubDetailsAboutUser(username = "") {
  const url = `https://api.github.com/users/${username}`;
  const { data } = await axios.get(url);
  return {
    login: data.login,
    name: data.name,
    blog: data.blog,
    public_repos: data.public_repos
  };
}

async function createDirectory(relativeDir = "") {
  const input = typeof relativeDir === "object" ? relativeDir.path || relativeDir.dir || relativeDir.folder || "" : relativeDir;
  const safeDir = normalizeRelativeOutputPath(input);
  const target = path.join(OUTPUT_ROOT, safeDir);
  await fs.mkdir(target, { recursive: true });
  return `Directory created: ${target}`;
}

async function writeTextFile(args = {}) {
  const payload = typeof args === "string" ? { path: args, content: "" } : args;
  const rawPath = payload.path || payload.file_path || payload.file || payload.filename || "";
  const relativePath = normalizeRelativeOutputPath(rawPath);
  const content = String(payload.content || payload.text || payload.data || "");
  if (!relativePath) throw new Error("path is required");

  const fullPath = path.join(OUTPUT_ROOT, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
  return `File written: ${fullPath}`;
}

async function readTextFile(relativePath = "") {
  const input = typeof relativePath === "object" ? relativePath.path || relativePath.file || "" : relativePath;
  const safePath = normalizeRelativeOutputPath(input);
  const fullPath = path.join(OUTPUT_ROOT, safePath);
  const content = await fs.readFile(fullPath, "utf-8");
  return content;
}

async function listFiles(relativeDir = "") {
  const input = typeof relativeDir === "object" ? relativeDir.path || relativeDir.dir || "" : relativeDir;
  const safeDir = normalizeRelativeOutputPath(input);
  const start = path.join(OUTPUT_ROOT, safeDir);
  const files = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else {
        files.push(path.relative(OUTPUT_ROOT, abs));
      }
    }
  }

  await walk(start);
  return files;
}

async function executeCommand(cmd = "") {
  const blocked = ["rm -rf /", "shutdown", "reboot", ":(){:|:&};:"];
  if (blocked.some((word) => cmd.includes(word))) {
    throw new Error("Command blocked for safety.");
  }
  const { stdout, stderr } = await execAsync(cmd, { cwd: PROJECT_ROOT });
  return { stdout, stderr };
}

const toolMap = {
  getTheWeatherOfCity,
  getGithubDetailsAboutUser,
  executeCommand,
  createDirectory,
  writeTextFile,
  readTextFile,
  listFiles
};

async function verifyGroqModel() {
  const response = await axios.get("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
  });
  const modelIds = (response.data?.data || []).map((m) => m.id);
  if (!modelIds.includes(DEFAULT_MODEL)) {
    throw new Error(
      `Model '${DEFAULT_MODEL}' is not available on this Groq key. Available models: ${modelIds.join(", ")}`
    );
  }
}

async function main() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Missing GROQ_API_KEY in environment.");
  }

  await verifyGroqModel();
  console.log(`Using Groq model: ${DEFAULT_MODEL}`);

  await ensureOutputRoot();

  const rl = readline.createInterface({ input, output });
  console.log("AI Agent CLI Tool");
  console.log("Type your instruction (or 'exit' to quit).\n");

  while (true) {
    const prompt = await rl.question("You > ");
    if (!prompt || prompt.trim().toLowerCase() === "exit") {
      break;
    }
    await runAgentLoop(prompt.trim());
    console.log("");
  }

  rl.close();
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
