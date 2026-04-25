import { Router } from 'express';
import { requireDeviceId } from '../middleware/deviceId';

const router = Router();

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Note: We use the env variable for the model if defined, else default
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemma-3-27b-it";

const DETECTION_PROMPT = `You are a strict JSON API for a travel inspiration app. Output ONLY a JSON object, nothing else.

Task: Identify genuine travel destinations in this social media post. The screenshot is your primary source.
CRITICAL RULES:
1. ONLY return isTravel: true if the MAIN FOCUS of the post is tourism, exploring, or showcasing a specific location's beauty/culture.
2. REJECT (isTravel: false) posts about: memes, gaming (e.g. Xbox, PlayStation), tech, news, comedy, music videos, or general internet culture.
3. REJECT posts where a location is merely in the background (e.g. a person talking to the camera in London, but the topic is gaming or comedy).
4. If it is a genuine travel post, list the destinations.

Example output: {"isTravel":true,"destinations":[{"destination":"Paris","country":"France","countryCode":"FR","airportCode":"CDG","vibes":["Romantic"]}]}
No travel / Rejected: {"isTravel":false,"destinations":[]}

Post text (supplementary): `;

function extractJson(text: string): any | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1];
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  const partial = text.slice(start);
  const lastComplete = partial.lastIndexOf("},");
  if (lastComplete > 0) {
    try { return JSON.parse(partial.slice(0, lastComplete + 1) + "]}"); } catch {}
  }
  return null;
}

router.post('/', requireDeviceId, async (req, res) => {
  const { text, screenshot, postId, platform } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in backend" });
  }

  const parts: any[] = [{ text: `${DETECTION_PROMPT}${text || ''}` }];
  if (screenshot) {
    parts.push({ inlineData: { mimeType: "image/jpeg", data: screenshot } });
  }

  try {
    const response = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 256, temperature: 0.1 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const result = extractJson(responseText);

    if (result) {
      return res.json(result);
    }
    
    return res.json({ isTravel: false, destinations: [] });
  } catch (err: any) {
    console.error("[Backend] Detect error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
