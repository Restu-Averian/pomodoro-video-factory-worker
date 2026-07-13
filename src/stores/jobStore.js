const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATES = new Set(['queued', 'rendering', 'validating', 'completed', 'failed', 'cancelled', 'delivered', 'cleaned', 'interrupted']);

function createJobStore(config) {
  console.log('createJobStore',config)
  const jobs = new Map();
  fs.mkdirSync(config.directories.jobs, { recursive: true });

  function assertJobId(jobId) {
    if (!JOB_ID.test(jobId)) throw new Error('Invalid job ID');
  }

  function jobPath(jobId) {
    assertJobId(jobId);
    return path.join(config.directories.jobs, `${jobId}.json`);
  }

  function writeJob(job) {
    const file = jobPath(job.id);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    console.log('tt',temporary)
    fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  }

  function createJob(data = {}) {
    const now = new Date().toISOString();
    const state = data.state || 'queued';
    if (!STATES.has(state)) throw new Error('Invalid job state');
    const job = { id: randomUUID(), kind: data.kind || 'render', state, createdAt: now, updatedAt: now, ...data };
    jobs.set(job.id, job);
    writeJob(job);
    return job;
  }

  function getJob(jobId) {
    assertJobId(jobId);
    return jobs.get(jobId) || null;
  }

  function updateJob(jobId, updates) {
    const job = getJob(jobId);
    if (!job) return null;
    if (updates.state && !STATES.has(updates.state)) throw new Error('Invalid job state');
    const updated = { ...job, ...updates, id: job.id, updatedAt: new Date().toISOString() };
    jobs.set(jobId, updated);
    writeJob(updated);
    return updated;
  }

  function listJobs() {
    return [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function loadJobsOnStartup() {
    jobs.clear();
    for (const file of fs.readdirSync(config.directories.jobs)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      if (!JOB_ID.test(id)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(config.directories.jobs, file), 'utf8'));
        if (!job || job.id !== id || !STATES.has(job.state)) continue;
        jobs.set(id, job);
      } catch (_) {
        // ponytail: invalid records are ignored; add quarantine handling only when operators need recovery tooling.
      }
    }
    for (const job of listJobs()) if (job.state === 'rendering' || job.state === 'validating') updateJob(job.id, { state: 'interrupted', interruptionReason: 'Worker restarted before completion' });
    return listJobs();
  }

  function removeJob(jobId) {
    assertJobId(jobId);
    jobs.delete(jobId);
    fs.rmSync(jobPath(jobId), { force: true });
  }

  return { createJob, getJob, updateJob, listJobs, loadJobsOnStartup, removeJob };
}

module.exports = { createJobStore, JOB_ID };
