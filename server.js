// server.js — single file (Node 18+ / ESM)
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ====== CONFIG ======
const PORT = process.env.PORT || 3001;
const MCPX_URL = "http://localhost:9000/mcp";
const CONSUMER_TAG = "my-chatbot-RonyS";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // pick a model you have

// ====== MCPX CLIENT (singleton) ======
let mcpClient;
async function getMcpClient() {
  if (mcpClient) return mcpClient;
  const transport = new StreamableHTTPClientTransport(new URL(MCPX_URL), {
    requestInit: { headers: { "x-lunar-consumer-tag": CONSUMER_TAG } },
  });
  const client = new Client({ name: CONSUMER_TAG, version: "1.0.0" });
  await client.connect(transport);
  mcpClient = client;
  console.log("✅ Connected to MCPX");
  return mcpClient;
}

// Optional: tiny cache for tool list (avoid spamming listTools)
let cachedTools = null;
let lastToolsFetch = 0;
async function ensureToolsFresh() {
  const now = Date.now();
  if (!cachedTools || now - lastToolsFetch > 60_000) {
    const mcp = await getMcpClient();
    const { tools } = await mcp.listTools();
    cachedTools = tools || [];
    lastToolsFetch = now;
    console.log("Tools:", cachedTools.map(t => t.name));
  }
  return cachedTools;
}

// ====== OPENAI CLIENT ======
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  Missing OPENAI_API_KEY in .env");
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// One generic tool for the model to reach any MCP tool.
const openAITools = [
  {
    type: "function",
    function: {
      name: "mcp_call",
      description:
        "Call an MCP tool by name with JSON args (e.g., Notion__notion-search, time__get_current_time).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact MCP tool name" },
          args: { type: "object", description: "Arguments object for that tool" }
        },
        required: ["name"]
      }
    }
  }
];

const SYSTEM = `
You are "my-chatbot". Be concise and helpful.
When a query requires Notion or timezone info, call MCP via mcp_call.
Summarize tool outputs clearly; include key IDs/links when useful.
`;

// ====== EXPRESS APP ======
const app = express();
app.use(cors());
app.use(express.json());

// --- Minimal in-browser GUI (kept in this single file) ---
app.get("/", (_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"/><title>my-chatbot</title>
<style>
  body{font-family:system-ui,Arial;margin:24px;max-width:900px}
  textarea{width:100%;height:140px}
  input,button,select{padding:6px;margin:4px 0}
  pre{background:#f6f6f6;padding:12px;border-radius:8px;overflow:auto}
  .row{display:flex;gap:8px;align-items:center}
  #log{white-space:pre-wrap;border:1px solid #ddd;padding:12px;min-height:160px}
</style></head>
<body>
<h2>my-chatbot (OpenAI + MCP)</h2>

<h3>Chat</h3>
<div id="log"></div>
<div class="row">
  <input id="msg" placeholder="Type a message" style="flex:1"/>
  <button id="send">Send</button>
</div>

<h3>Call an MCP tool manually</h3>
<div class="row">
  <button id="refresh">Refresh tools</button>
  <span id="status"></span>
</div>
<select id="tool"></select>
<textarea id="args">{}</textarea>
<div class="row"><button id="call">Call Tool</button></div>
<pre id="out">—</pre>

<script>
  const log = document.getElementById('log');
  const input = document.getElementById('msg');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('status');
  const toolSel = document.getElementById('tool');
  const argsEl = document.getElementById('args');
  const outEl = document.getElementById('out');

  function add(role, text){ const p=document.createElement('div'); p.textContent=role+": "+text; log.appendChild(p); log.scrollTop=log.scrollHeight; }

  async function send(){
    const text = input.value.trim(); if(!text) return;
    add("You", text); input.value="";
    const r = await fetch("/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:text}]})});
    const data = await r.json();
    add("Bot", data.reply || JSON.stringify(data));
  }

  async function loadTools(){
    statusEl.textContent = "Loading...";
    toolSel.innerHTML = "";
    try{
      const r = await fetch("/api/tools"); const data = await r.json();
      (data.tools||[]).forEach(t=>{ const o=document.createElement('option'); o.value=t.name; o.textContent=t.name+" — "+(t.description||""); toolSel.appendChild(o); });
      statusEl.textContent = "Loaded "+(data.tools?data.tools.length:0)+" tools";
    }catch(e){ statusEl.textContent="Failed to load tools"; }
  }

  async function callTool(){
    outEl.textContent="Calling...";
    let args={}; try{ args = argsEl.value.trim()? JSON.parse(argsEl.value):{}; }catch{ outEl.textContent="Args must be valid JSON"; return; }
    const name = toolSel.value; if(!name){ outEl.textContent="Pick a tool"; return; }
    const r = await fetch("/api/call",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name, args})});
    const data = await r.json(); outEl.textContent = JSON.stringify(data,null,2);
  }

  sendBtn.onclick = send;
  document.getElementById('refresh').onclick = loadTools;
  document.getElementById('call').onclick = callTool;
  loadTools();
</script>
</body></html>`);
});

// --- List MCP tools (for GUI dropdown) ---
app.get("/api/tools", async (_req, res) => {
  try {
    const tools = await ensureToolsFresh();
    res.json({ tools });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to list tools" });
  }
});

// --- Manual MCP passthrough (GUI "Call Tool" button) ---
app.post("/api/call", async (req, res) => {
  try {
    const { name, args = {} } = req.body || {};
    if (!name) return res.status(400).json({ error: "Missing 'name'." });
    const mcp = await getMcpClient();
    const result = await mcp.callTool({ name, arguments: args });
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Tool call failed" });
  }
});

// --- Chat route: model can call MCP tools automatically ---
app.post("/chat", async (req, res) => {
  try {
    const { messages = [] } = req.body || {};

    // 1) First round — the model may ask to call mcp_call
    const first = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: openAITools,
      tool_choice: "auto"
    });

    const choice = first.choices[0];
    const toolCalls = choice.message.tool_calls || [];
    let running = [{ role: "system", content: SYSTEM }, ...messages, choice.message];

    // 2) Execute any tool calls
    if (toolCalls.length) {
      const mcp = await getMcpClient();
      for (const call of toolCalls) {
        if (call.function?.name !== "mcp_call") continue;
        let parsed = {};
        try { parsed = JSON.parse(call.function.arguments || "{}"); } catch {}
        const { name, args = {} } = parsed;
        let toolResult;
        try {
          toolResult = await mcp.callTool({ name, arguments: args });
        } catch (err) {
          toolResult = { error: err?.message || "MCP call failed" };
        }
        running.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult) });
      }

      // 3) Final answer after tools
      const final = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: running
      });
      const reply = final.choices?.[0]?.message?.content || "";
      return res.json({ reply, raw: final });
    }

    // No tool call requested — use first reply
    const reply = choice.message?.content || "";
    res.json({ reply, raw: first });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "Chat failed" });
  }
});

// ====== START ======
app.listen(PORT, async () => {
  await ensureToolsFresh().catch(() => {});
  console.log(`Server: http://localhost:${PORT}`);
});
