import { EventEmitter } from 'node:events';
import mongoose, { Types } from 'mongoose';
import { DomainEventModel } from '../models/domainEvent.model.js';

const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DurableEventDto {
  cursor: string;
  eventName: string;
  payload: unknown;
  createdAt: string;
}

class LiveEvents extends EventEmitter {
  publish(eventName: string, payload: unknown): void {
    this.emit(eventName, payload);
    if (mongoose.connection.readyState !== 1) return;
    void DomainEventModel.create({
      eventName,
      payload,
      expiresAt: new Date(Date.now() + EVENT_RETENTION_MS)
    }).catch(() => undefined);
  }

  async latestCursor(eventName: string): Promise<string | undefined> {
    const latest = await DomainEventModel.findOne({ eventName }).sort({ _id: -1 }).select('_id').lean<{ _id: Types.ObjectId } | null>();
    return latest?._id.toString();
  }

  async readAfter(eventName: string, cursor?: string, limit = 100): Promise<DurableEventDto[]> {
    const query: Record<string, unknown> = { eventName };
    if (cursor && Types.ObjectId.isValid(cursor)) query._id = { $gt: new Types.ObjectId(cursor) };
    const records = await DomainEventModel.find(query)
      .sort({ _id: 1 })
      .limit(Math.max(1, Math.min(500, limit)))
      .lean<Array<{ _id: Types.ObjectId; eventName: string; payload: unknown; createdAt: Date }>>();
    return records.map((record) => ({
      cursor: record._id.toString(),
      eventName: record.eventName,
      payload: record.payload,
      createdAt: record.createdAt.toISOString()
    }));
  }
}

export const liveEvents = new LiveEvents();
liveEvents.setMaxListeners(100);
