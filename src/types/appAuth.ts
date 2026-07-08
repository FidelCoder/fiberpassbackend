import type { Request } from 'express';
import type { AppAuthContext } from '../services/app.service.js';

export interface AppAuthenticatedRequest extends Request {
  appAuth: AppAuthContext;
}
