function createQueueManager(store, options = {}) {
  let activeJobId = null;
  let draining = false;

  async function drain() {
    if (draining || activeJobId) return;
    draining = true;
    try {
      while (!activeJobId) {
        const job = store.listJobs().find((candidate) => candidate.state === 'queued');
        if (!job) return;
        activeJobId = job.id;
        try {
          if (!options.renderJob) return;
          await options.renderJob(job.id);
        } finally {
          activeJobId = null;
        }
      }
    } finally {
      draining = false;
    }
  }

  function enqueue() {
    setImmediate(() => {
      drain().catch((error) => console.error('Remote render queue failed:', error));
    });
  }

  function getStatus() {
    const queuedJobs = store.listJobs().filter((job) => job.state === 'queued');
    return { activeJobId, queuedJobCount: queuedJobs.length, queuedJobs };
  }

  return { getStatus, enqueue, drain };
}

module.exports = { createQueueManager };
