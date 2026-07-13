function createQueueManager(store) {
  let activeJobId = null;

  function getStatus() {
    const queuedJobs = store.listJobs().filter((job) => job.state === 'queued');
    return { activeJobId, queuedJobCount: queuedJobs.length, queuedJobs };
  }

  return { getStatus };
}

module.exports = { createQueueManager };
