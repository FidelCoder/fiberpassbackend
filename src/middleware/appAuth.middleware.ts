import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors.js';
import { authenticateAppApiKey } from '../services/app.service.js';

function readApiKey(request: Request): string {
  const explicitKey = request.header('x-fiberpass-api-key');
  if (explicitKey) return explicitKey.trim();

  const header = request.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return '';
}

export async function requireAppApiKey(request: Request, _response: Response, next: NextFunction): Promise<void> {
  try {
    const apiKey = readApiKey(request);
    if (!apiKey) {
      throw new ApiError(401, 'APP_API_KEY_REQUIRED', 'App API key is required.');
    }

    (request as Request & { appAuth: unknown }).appAuth = await authenticateAppApiKey(apiKey, request.params.appId);
    next();
  } catch (error) {
    next(error);
  }
}
