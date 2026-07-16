import { Schema, model, type InferSchemaType } from 'mongoose';

const domainEventSchema = new Schema(
  {
    eventName: { type: String, required: true, trim: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false
  }
);

domainEventSchema.index({ eventName: 1, _id: 1 });

export type DomainEventRecord = InferSchemaType<typeof domainEventSchema>;
export const DomainEventModel = model('DomainEvent', domainEventSchema);
