const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfig } = require('../src/config');
const { createJobStore } = require('../src/stores/jobStore');
const { createQueueManager } = require('../src/services/queueManager');
const { createApp } = require('../src/app');

function makeWorker() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'niititu-worker-'));
  const config = createConfig({
    WORKER_ROOT: root,
    WORKER_API_TOKEN: 'test-token',
    WORKER_HOST: '127.0.0.1',
  });
  const store = createJobStore(config);
  store.loadJobsOnStartup();
  const queue = createQueueManager(store);
  const app = createApp({ config, store, queue, commandAvailable: async () => false });
  return { root, store, queue, app };
}

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health is public and authenticated status rejects missing and wrong tokens', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));

  await withServer(worker.app, async (url) => {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    assert.equal((await fetch(`${url}/api/status`)).status, 401);
    assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);

    const status = await fetch(`${url}/api/status`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(status.status, 200);
    assert.equal(typeof (await status.json()).ready, 'boolean');
  });
});

test('test jobs persist atomically and unsafe job IDs cannot access files', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));

  await withServer(worker.app, async (url) => {
    const headers = { Authorization: 'Bearer test-token' };
    const created = await fetch(`${url}/api/jobs/test`, { method: 'POST', headers });
    assert.equal(created.status, 201);
    const job = await created.json();
    assert.match(job.id, /^[a-f0-9-]{36}$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(worker.root, 'jobs', `${job.id}.json`), 'utf8')).kind, 'test');
    assert.equal((await fetch(`${url}/api/jobs/..%2Fsecret`, { headers })).status, 400);
  });
});

test('startup marks rendering and validating jobs as interrupted and restores queued jobs', (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  const rendering = worker.store.createJob({ kind: 'test', state: 'rendering' });
  const validating = worker.store.createJob({ kind: 'test', state: 'validating' });
  const queued = worker.store.createJob({ kind: 'test', state: 'queued' });

  const restarted = createJobStore(createConfig({ WORKER_ROOT: worker.root, WORKER_API_TOKEN: 'test-token' }));
  restarted.loadJobsOnStartup();
  const queue = createQueueManager(restarted);

  assert.equal(restarted.getJob(rendering.id).state, 'interrupted');
  assert.equal(restarted.getJob(validating.id).state, 'interrupted');
  assert.equal(queue.getStatus().queuedJobCount, 1);
  assert.equal(queue.getStatus().activeJobId, null);
  assert.equal(restarted.getJob(queued.id).state, 'queued');
});
