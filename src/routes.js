const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const multer = require('multer');
const { JOB_ID } = require('./stores/jobStore');
const { assertSafeAssetPath, validateManifest, requiredLogicalPaths } = require('./services/renderService');

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
  const storage = multer.diskStorage({
    destination(req, file, callback) {
      try {
        assertSafeAssetPath(file.fieldname);
        callback(null, path.join(req.remoteJob.uploadDir, 'assets'));
      } catch (error) {
        callback(error);
      }
    },
    filename(req, file, callback) {
      try {
        assertSafeAssetPath(file.fieldname);
        callback(null, path.basename(file.fieldname));
      } catch (error) {
        callback(error);
      }
    },
  });
  const upload = multer({ storage }).any();

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
  router.post('/jobs', (req, res, next) => {
    const job = store.createJob({ kind: 'render', state: 'receiving', progress: 0, currentStep: 'Receiving sources' });
    const uploadDir = path.join(config.directories.uploads, job.id);
    const tempDir = path.join(config.directories.temp, job.id);
    const outputDir = path.join(config.directories.outputs, job.id);
    for (const directory of [path.join(uploadDir, 'assets'), tempDir, outputDir]) fs.mkdirSync(directory, { recursive: true });
    req.remoteJob = store.updateJob(job.id, { uploadDir, tempDir, outputDir });
    next();
  }, (req, res, next) => {
    upload(req, res, (error) => {
      if (error) {
        if (req.remoteJob) store.updateJob(req.remoteJob.id, { state: 'failed', currentStep: 'Upload failed', errorMessage: error.message });
        return res.status(400).json({ error: error.message });
      }
      next();
    });
  }, (req, res) => {
    try {
      const manifest = JSON.parse(req.body.manifest || 'null');
      validateManifest(manifest);
      const uploaded = new Set((req.files || []).map((file) => file.fieldname));
      const missing = requiredLogicalPaths(manifest).filter((logicalPath) => !uploaded.has(logicalPath));
      if (missing.length) throw new Error(`Missing source files: ${missing.join(', ')}`);
      const manifestPath = path.join(req.remoteJob.uploadDir, 'manifest.json');
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const job = store.updateJob(req.remoteJob.id, { state: 'queued', progress: 0, currentStep: 'Queued', manifest, manifestPath });
      queue.enqueue();
      res.status(201).json(job);
    } catch (error) {
      store.updateJob(req.remoteJob.id, { state: 'failed', currentStep: 'Upload rejected', errorMessage: error.message });
      res.status(400).json({ error: error.message });
    }
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
