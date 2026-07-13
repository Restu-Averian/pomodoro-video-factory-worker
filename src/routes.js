const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { JOB_ID } = require('./stores/jobStore');

function authenticated(config) {
  return (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const received = Buffer.from(match?.[1] || '');
    const expected = Buffer.from(config.token);
    if (!match || received.length !== expected.length || !timingSafeEqual(received, expected)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
}

function validJobId(req, res, next) {
  if (!JOB_ID.test(req.params.jobId)) return res.status(400).json({ error: 'Invalid job ID' });
  next();
}

function createRoutes({ config, store, queue, availability }) {
  const router = express.Router();
  router.use(authenticated(config));

  router.get('/status', (_req, res) => {
    const status = queue.getStatus();
    res.json({ activeJobId: status.activeJobId, activeJob: status.activeJobId ? store.getJob(status.activeJobId) : null, queuedJobs: status.queuedJobs, queuedJobCount: status.queuedJobCount, ready: config.maxActiveRenders === 1 && availability.ffmpeg && availability.ffprobe, ffmpegAvailable: availability.ffmpeg, ffprobeAvailable: availability.ffprobe });
  });
  router.get('/jobs', (_req, res) => res.json({ jobs: store.listJobs(), ...queue.getStatus() }));
  router.get('/jobs/:jobId', validJobId, (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });
  router.post('/jobs/test', (_req, res) => res.status(201).json(store.createJob({ kind: 'test', state: 'queued' })));
  router.delete('/jobs/:jobId', validJobId, (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!(job.kind === 'test' || ['failed', 'cancelled', 'interrupted', 'delivered', 'cleaned'].includes(job.state))) return res.status(409).json({ error: 'Job cannot be deleted in its current state' });
    store.removeJob(job.id);
    res.status(204).end();
  });
  return router;
}

module.exports = { createRoutes };
