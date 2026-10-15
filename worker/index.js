// Cloudflare Worker: answers study questions with Claude, grounded in the Supercharger Field Guide material.
// The Anthropic API key lives in the ANTHROPIC_API_KEY secret, never in the public page.
import { KNOWLEDGE } from "./knowledge.js";

const MODEL = "claude-haiku-5-5";
const ALLOWED_ORIGINS = ["https://dcpeaks50.github.io", "null"]; // "null" = the page opened as a local file
const PER_IP_PER_DAY = 40;
const SITE_PER_DAY = 400;
const MAX_QUESTION = 600;

const INSTRUCTIONS = `You are the study assistant inside the "Supercharger Field Guide", a learning site for people who design and install Tesla V4 Supercharger cabinets and posts (and need to know Semi Megacharger differences).

Answer questions using the reference material provided. Rules:
- Plain English, short and practical: lead with the direct answer in 1-3 sentences, then key numbers or steps as a short list if helpful. Define jargon the first time.
- Cite where it comes from in parentheses, e.g. (Design Manual p.14) or (V4 Cabinet datasheet).
- Focus on the V4 cabinet and V4 post. Mention the Semi only when asked or when the difference matters.
- If the material doesn't cover it, say so plainly, then you may add general industry knowledge clearly labeled "General knowledge, not from the Tesla docs:". Never invent Tesla numbers.
- For code or safety-critical decisions, remind them the stamped plans, the current Tesla documents, and the AHJ govern.
- Format with simple markdown: **bold**, short "- " lists. No tables, no headings.`;

const cors = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
});
const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });

async function overLimit(env, ip) {
  if (!env.LIMITS) return false;
  const day = new Date().toISOString().slice(0, 10);
  const [site, mine] = await Promise.all([env.LIMITS.get(`site:${day}`), env.LIMITS.get(`ip:${day}:${ip}`)]);
  if (+(site || 0) >= SITE_PER_DAY || +(mine || 0) >= PER_IP_PER_DAY) return true;
  await Promise.all([
    env.LIMITS.put(`site:${day}`, String(+(site || 0) + 1), { expirationTtl: 172800 }),
    env.LIMITS.put(`ip:${day}:${ip}`, String(+(mine || 0) + 1), { expirationTtl: 172800 }),
  ]);
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "POST a question." }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "Not allowed." }, 403, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400, origin); }
    const question = String(body.question || "").trim().slice(0, MAX_QUESTION);
    if (!question) return json({ error: "Ask a question." }, 400, origin);
    // Up to 3 earlier exchanges for follow-ups.
    const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    if (await overLimit(env, request.headers.get("CF-Connecting-IP") || "unknown")) {
      return json({ error: "Daily question limit reached. Try again tomorrow." }, 429, origin);
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: [
          { type: "text", text: INSTRUCTIONS },
          // The big reference block is cached, so repeat questions cost a fraction of the first.
          { type: "text", text: "REFERENCE MATERIAL:\n\n" + KNOWLEDGE, cache_control: { type: "ephemeral" } },
        ],
        messages: [...history, { role: "user", content: question }],
      }),
    });
    if (!res.ok) {
      console.error("anthropic", res.status, await res.text());
      return json({ error: "Claude couldn't answer right now. Try again in a minute." }, 502, origin);
    }
    const data = await res.json();
    const answer = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    return json({ answer }, 200, origin);
  },
};
