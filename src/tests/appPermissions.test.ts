import assert from 'node:assert/strict';
import { DEFAULT_APP_API_KEY_SCOPES } from '../models/app.model.js';
import { hasRequiredAppApiKeyScopes, normalizeAppApiKeyScopes } from '../services/app.service.js';

assert.deepEqual(normalizeAppApiKeyScopes(undefined), DEFAULT_APP_API_KEY_SCOPES);
assert.deepEqual(normalizeAppApiKeyScopes([]), DEFAULT_APP_API_KEY_SCOPES);
assert.deepEqual(normalizeAppApiKeyScopes(['recipients:write', 'recipients:write', 'not-real']), ['recipients:write']);
assert.equal(hasRequiredAppApiKeyScopes(['charges:create'], ['charges:create']), true);
assert.equal(hasRequiredAppApiKeyScopes(['charges:create'], ['recipients:write']), false);
assert.equal(hasRequiredAppApiKeyScopes(['recipients:read', 'recipients:write'], ['recipients:read', 'recipients:write']), true);
assert.equal(hasRequiredAppApiKeyScopes(undefined, []), true);
