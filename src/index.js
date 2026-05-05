import "dotenv/config";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execAsync = promisify(exec);
const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROJECT_ROOT = process.cwd();
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "generated_sites");
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function buildTranscript(messages) {
  return messages
    .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join("\n\n");
}

async function generateAgentStep(messages) {
  const prompt = `${buildTranscript(messages)}\n\nReturn ONLY valid JSON for your next step.`;
  const model = client.getGenerativeModel({ model: DEFAULT_MODEL });
  const response = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  });
  return response.response.text() || "{}";
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
  const safeDir = relativeDir.replace(/^\/+/, "");
  const target = path.join(OUTPUT_ROOT, safeDir);
  await fs.mkdir(target, { recursive: true });
  return `Directory created: ${target}`;
}

async function writeTextFile(args = {}) {
  const relativePath = String(args.path || "").replace(/^\/+/, "");
  const content = String(args.content || "");
  if (!relativePath) throw new Error("path is required");

  const fullPath = path.join(OUTPUT_ROOT, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
  return `File written: ${fullPath}`;
}

async function readTextFile(relativePath = "") {
  const safePath = relativePath.replace(/^\/+/, "");
  const fullPath = path.join(OUTPUT_ROOT, safePath);
  const content = await fs.readFile(fullPath, "utf-8");
  return content;
}

async function listFiles(relativeDir = "") {
  const safeDir = relativeDir.replace(/^\/+/, "");
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
`;

async function runAgentLoop(userInstruction) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userInstruction }
  ];

  while (true) {
    const raw = await generateAgentStep(messages);
    let parsed;
    try {
      parsed = JSON.parse(raw);
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
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY in environment.");
  }

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
