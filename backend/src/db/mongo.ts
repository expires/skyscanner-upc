import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { EngagementEvent, InterestScore, WishlistEntry } from '../types';

let db: Db;

export interface EventDocument extends EngagementEvent {
  _id?: ObjectId;
  deviceId: string;
  createdAt: Date;
}

export interface ScoreDocument extends InterestScore {
  _id?: ObjectId;
  deviceId: string;
}

export interface WishlistDocument extends WishlistEntry {
  _id?: ObjectId;
  deviceId: string;
}

export async function connectMongo() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/roam';
  const client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  console.log('MongoDB connected');
}

export function getDb() {
  if (!db) throw new Error("DB not connected");
  return db;
}

export function getEventsCollection(): Collection<EventDocument> {
  return getDb().collection<EventDocument>('events');
}

export function getScoresCollection(): Collection<ScoreDocument> {
  return getDb().collection<ScoreDocument>('scores');
}

export function getWishlistCollection(): Collection<WishlistDocument> {
  return getDb().collection<WishlistDocument>('wishlist');
}
