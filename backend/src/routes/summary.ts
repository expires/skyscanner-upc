import { Router } from 'express';
import { requireDeviceId } from '../middleware/deviceId';

const router = Router();

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemma-3-27b-it";

router.post('/', requireDeviceId, async (req, res) => {
  const { prompt, maxTokens = 256, temperature = 1.0 } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY in backend" });
  }

  try {
    const response = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      }),
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: await response.text() });
    }

    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    console.error("[Backend] Summary error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
