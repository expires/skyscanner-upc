import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { connectMongo } from './db/mongo';

import detectRouter from './routes/detect';
import flightsRouter from './routes/flights';
import eventsRouter from './routes/events';
import scoresRouter from './routes/scores';

import summaryRouter from './routes/summary';

// Load environment variables
dotenv.config();

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' })); // Increased limit for screenshots

// Serve static API documentation website
app.use(express.static(path.join(__dirname, '../public')));

app.use('/detect', detectRouter);
app.use('/flights', flightsRouter);
app.use('/events', eventsRouter);
app.use('/scores', scoresRouter);
app.use('/summary', summaryRouter);

app.get('/health', (_, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;

connectMongo().then(() => {
  app.listen(PORT, () => console.log(`Roam backend listening on port ${PORT}`));
}).catch(err => {
  console.error("Failed to connect to MongoDB", err);
  process.exit(1);
});
