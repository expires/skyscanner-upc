import { Request, Response, NextFunction } from 'express';

export function requireDeviceId(req: Request, res: Response, next: NextFunction) {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId || typeof deviceId !== 'string') {
    res.status(401).json({ error: 'Missing or invalid x-device-id header' });
    return;
  }
  
  // Attach deviceId to the request for downstream use if needed, 
  // or simply let routes access it via req.headers.
  req.deviceId = deviceId;
  next();
}

// Augment Express Request to hold deviceId
declare global {
  namespace Express {
    interface Request {
      deviceId?: string;
    }
  }
}
