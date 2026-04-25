import { Router } from 'express';
import { requireDeviceId } from '../middleware/deviceId';
import { getEventsCollection, EventDocument } from '../db/mongo';
import { EngagementEvent } from '../types';

import { streamEventsToPowerBI } from '../services/powerbi';

const router = Router();

router.post('/', requireDeviceId, async (req, res) => {
  const { events } = req.body;
  const deviceId = req.deviceId!;

  if (!events || !Array.isArray(events)) {
    return res.status(400).json({ error: "Invalid events array" });
  }

  try {
    const collection = getEventsCollection();
    const docs: EventDocument[] = events.map((e: EngagementEvent) => ({
      ...e,
      deviceId,
      createdAt: new Date()
    }));

    if (docs.length > 0) {
      await collection.insertMany(docs);
      
      // stream to Power BI (V5) — fire and forget
      streamEventsToPowerBI(docs).catch(() => {});
    }
    
    res.json({ success: true, inserted: docs.length });
  } catch (err: any) {
    console.error("[Backend] Events error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
