const runBtn = document.getElementById("runBtn");
const promptEl = document.getElementById("prompt");
const statusEl = document.getElementById("status");
const traceEl = document.getElementById("trace");
const previewEl = document.getElementById("preview");
const filesEl = document.getElementById("files");

function escHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderTrace(trace = []) {
  traceEl.innerHTML = trace
    .map((entry) => {
      const content = escHtml(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
      const toolPart = entry.tool_name ? `<div><strong>tool:</strong> ${escHtml(entry.tool_name)}</div>` : "";
      return `<div class="step"><div><strong>${escHtml(entry.step || "STEP")}</strong></div>${toolPart}<div>${content}</div></div>`;
    })
    .join("");
}

function buildPreviewHtml(files = {}) {
  const html = files["index.html"] || files["scaler_clone/index.html"] || "";
  const css = files["styles.css"] || files["scaler_clone/styles.css"] || "";
  const js = files["script.js"] || files["scaler_clone/script.js"] || "";
  if (!html) return "";

  let output = html.replace(/<link[^>]*href=["']styles\.css["'][^>]*>/i, `<style>${css}</style>`);
  output = output.replace(/<script[^>]*src=["']script\.js["'][^>]*>\s*<\/script>/i, `<script>${js}<\/script>`);
  if (!output.includes("<style>") && css) output = `${output}\n<style>${css}</style>`;
  if (!output.includes("<script>") && js) output = `${output}\n<script>${js}<\/script>`;
  return output;
}

runBtn.addEventListener("click", async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    statusEl.textContent = "Please enter a prompt.";
    return;
  }

  runBtn.disabled = true;
  statusEl.textContent = "Running agent...";
  traceEl.innerHTML = "";
  filesEl.innerHTML = "";
  previewEl.srcdoc = "";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");

    statusEl.textContent = `Done. Model used: ${data.model}. ${data.output || ""}`;
    renderTrace(data.trace || []);

    const fileNames = Object.keys(data.files || {});
    filesEl.innerHTML = fileNames.length ? `Generated files: ${fileNames.join(", ")}` : "No files generated.";

    const preview = buildPreviewHtml(data.files || {});
    previewEl.srcdoc = preview || "<h2 style='font-family:sans-serif;padding:16px'>No preview available</h2>";
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  } finally {
    runBtn.disabled = false;
  }
});
