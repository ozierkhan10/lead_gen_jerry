// ============================================================
// Lead Triage Bot — forward any inbound lead message to this
// bot on Telegram and get back a summary + score in seconds.
// Built with grammY + Claude API.
// ============================================================

require("dotenv").config();
const { Bot } = require("grammy");
const Anthropic = require("@anthropic-ai/sdk");

// ---- Config ------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_ID = Number(process.env.OWNER_TELEGRAM_ID); // your numeric Telegram ID

if (!BOT_TOKEN || !ANTHROPIC_API_KEY || !OWNER_ID) {
  console.error("Missing env vars. Need TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, OWNER_TELEGRAM_ID.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---- The scoring rubric (system prompt) --------------------
const SYSTEM_PROMPT = `You are a lead qualification analyst for a firm that provides company structuring, back office (accounting, bookkeeping, payroll, compliance), and fractional CFO services. Clients are typically startups and Web3 organizations (post-raise companies, foundations, DAOs needing legal wrappers, protocols going through token events) plus traditional SMEs expanding cross-border.

You will receive an inbound message (or screenshot of one) forwarded from Telegram. Analyze it and score the lead.

SCORING WEIGHTS (total 100):
1. Trigger event (30 pts): just closed a funding round, token launch/TGE upcoming, expanding to a new jurisdiction, audit or tax deadline, investors demanding proper reporting, debating a first finance hire. No trigger event = low score here.
2. Budget capacity (25 pts): evidence of funding (announced raise, treasury, revenue) vs pre-money idea stage.
3. Decision-maker (20 pts): founder / CEO / COO / ops lead = high. Community member "asking around" or unclear role = low.
4. Complexity fit (15 pts): multi-jurisdiction setups, crypto treasury, token accounting, cross-border payroll = high fit. Simple single-entity bookkeeping = lower.
5. Urgency (10 pts): named deadline ("TGE in 6 weeks", "filing due next month") vs "just exploring".

AUTO-COLD (score under 25 regardless): pre-funding ideas with no money, free-advice fishing ("pick your brain"), job seekers, token shillers, anyone asking the firm to INVEST rather than hire it, obvious spam/scams.

TIERS: 75-100 = HOT, 50-74 = WARM, 25-49 = COLD, 0-24 = SPAM/IGNORE.

Respond ONLY with valid JSON, no markdown fences, in exactly this shape:
{
  "lead_name": "name and role/company if identifiable, else 'Unknown'",
  "score": 0-100,
  "tier": "HOT" | "WARM" | "COLD" | "SPAM",
  "summary": "2-3 sentence plain-English summary of what they need",
  "jurisdiction": "jurisdiction(s) mentioned or implied, else 'Not mentioned'",
  "signals": ["short positive signals, e.g. 'seed round closed', 'founder-level contact'"],
  "red_flags": ["short concerns, e.g. 'no budget evidence', 'vague timeline'"],
  "next_step": "one concrete suggested next action"
}`;

// ---- Helpers -----------------------------------------------
const tierEmoji = { HOT: "🔥", WARM: "🌤", COLD: "❄️", SPAM: "🗑" };

function formatReply(r) {
  const lines = [
    `*Lead:* ${r.lead_name}`,
    `*Score:* ${r.score}/100 ${tierEmoji[r.tier] || ""} ${r.tier}`,
    ``,
    `*Summary:* ${r.summary}`,
    `*Jurisdiction:* ${r.jurisdiction}`,
  ];
  if (r.signals?.length) lines.push(`*Signals:* ${r.signals.map((s) => `✅ ${s}`).join("  ")}`);
  if (r.red_flags?.length) lines.push(`*Flags:* ${r.red_flags.map((s) => `⚠️ ${s}`).join("  ")}`);
  lines.push(``, `*Next step:* ${r.next_step}`);
  return lines.join("\n");
}

// Escape characters that break Telegram Markdown
function safeMd(text) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function scoreLead(contentBlocks) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: contentBlocks }],
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();
  return JSON.parse(text);
}

// Download a Telegram photo and return base64 + media type
async function getPhotoBase64(ctx) {
  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  const file = await ctx.api.getFile(largest.file_id);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

// ---- Bot handlers ------------------------------------------
bot.command("start", (ctx) =>
  ctx.reply(
    "👋 Forward me any inbound lead message (text or screenshot) and I'll reply with a summary, score, and suggested next step."
  )
);

bot.command("id", (ctx) => ctx.reply(`Your Telegram ID: ${ctx.from.id}`));

bot.on("message", async (ctx) => {
  // Only the owner can use this bot
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("Sorry, this is a private bot.");
  }

  const msg = ctx.message;
  const hasText = msg.text || msg.caption;
  const hasPhoto = !!msg.photo;
  if (!hasText && !hasPhoto) return;

  try {
    await ctx.replyWithChatAction("typing");

    // Build the content we send to Claude
    const content = [];

    // Include who forwarded/sent it, if Telegram exposes it
    const origin = msg.forward_origin;
    let senderInfo = "";
    if (origin?.type === "user") {
      const u = origin.sender_user;
      senderInfo = `Forwarded from: ${u.first_name || ""} ${u.last_name || ""} (@${u.username || "no username"})`;
    } else if (origin?.type === "hidden_user") {
      senderInfo = `Forwarded from: ${origin.sender_user_name} (privacy-hidden account)`;
    }

    if (hasPhoto) {
      const b64 = await getPhotoBase64(ctx);
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: b64 },
      });
    }

    const textParts = [senderInfo, msg.text || msg.caption || "(screenshot only — read the image)"]
      .filter(Boolean)
      .join("\n\n");
    content.push({ type: "text", text: `Inbound lead message:\n\n${textParts}` });

    const result = await scoreLead(content);

    await ctx.reply(formatReply(result), {
      parse_mode: "Markdown",
      reply_to_message_id: msg.message_id,
    });
  } catch (err) {
    console.error("Error scoring lead:", err);
    await ctx.reply("⚠️ Couldn't score that one — try forwarding it again in a moment.");
  }
});

bot.catch((err) => console.error("Bot error:", err));

bot.start();
console.log("✅ Lead Triage Bot is running...");
