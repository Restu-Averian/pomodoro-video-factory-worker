const path = require('node:path');

function required(value, name) {
  if (!value || !String(value).trim()) throw new Error(`${name} is required`);
  return String(value).trim();
}

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function createConfig(env = process.env) {
  const root = required(env.WORKER_ROOT, 'WORKER_ROOT');
  return {
    host: env.WORKER_HOST || '0.0.0.0',
    port: positiveInteger(env.WORKER_PORT || '4010', 'WORKER_PORT'),
    root,
    token: required(env.WORKER_API_TOKEN, 'WORKER_API_TOKEN'),
    maxActiveRenders: positiveInteger(env.WORKER_MAX_ACTIVE_RENDERS || '1', 'WORKER_MAX_ACTIVE_RENDERS'),
    retentionHours: positiveInteger(env.WORKER_RETENTION_HOURS || '24', 'WORKER_RETENTION_HOURS'),
    directories: Object.fromEntries(['jobs', 'uploads', 'temp', 'outputs', 'logs'].map((name) => [name, path.join(root, name)])),
  };
}

module.exports = { createConfig };
