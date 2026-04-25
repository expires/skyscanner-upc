import { Router } from 'express';
import { requireDeviceId } from '../middleware/deviceId';
import { getScoresCollection, ScoreDocument } from '../db/mongo';
import { InterestScore } from '../types';

const router = Router();

router.get('/', requireDeviceId, async (req, res) => {
  const deviceId = req.deviceId!;
  try {
    const collection = getScoresCollection();
    const scores = await collection.find({ deviceId }).toArray();
    res.json({
      scores: scores.map(({ _id, deviceId, ...score }) => score),
      lastUpdated: Date.now()
    });
  } catch (err: any) {
    console.error("[Backend] GET /scores error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireDeviceId, async (req, res) => {
  const { scores } = req.body;
  const deviceId = req.deviceId!;

  if (!scores || !Array.isArray(scores)) {
    return res.status(400).json({ error: "Invalid scores array" });
  }

  try {
    const collection = getScoresCollection();
    
    // Upsert each score
    const operations = scores.map((s: InterestScore) => ({
      updateOne: {
        filter: { deviceId, destination: s.destination },
        update: { $set: { ...s, deviceId } },
        upsert: true
      }
    }));

    if (operations.length > 0) {
      await collection.bulkWrite(operations);
    }

    res.json({ success: true, updated: operations.length });
  } catch (err: any) {
    console.error("[Backend] POST /scores error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
