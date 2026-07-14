const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfig } = require('../src/config');
const { createJobStore } = require('../src/stores/jobStore');
const { createQueueManager } = require('../src/services/queueManager');
const { createApp } = require('../src/app');
const { resolveRenderManifest } = require('../src/services/renderService');

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
  return { root, config, store, queue, app };
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
    const body = await status.json();
    assert.equal(typeof body.ready, 'boolean');
    assert.equal(body.renderUploadSupported, true);
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

function testManifest() {
  return {
    version: 1,
    config: {
      isPreview: true,
      sessionCount: 1,
      timerTextColor: '0x7D6556',
      finalFilename: 'remote-test.mp4',
    },
    assets: {
      focusVideo: 'assets/focus-video.mp4',
      breakVideo: 'assets/break-video.mp4',
      fontItalic: 'assets/CormorantGaramond-Italic.ttf',
      audioPlan: [{ type: 'focus', sessionIndex: 1, durationSeconds: 15, audioPath: 'assets/focus-audio.mp3' }],
    },
  };
}

function uploadForm(manifest, files = {}) {
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  for (const [logicalPath, value] of Object.entries(files)) {
    form.append('assets', new Blob([value || 'x']), path.basename(logicalPath));
  }
  return form;
}

test('render job submission validates auth, manifest, path traversal, and missing sources', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));

  await withServer(worker.app, async (url) => {
    const manifest = testManifest();
    assert.equal((await fetch(`${url}/api/jobs`, { method: 'POST', body: uploadForm(manifest) })).status, 401);

    const headers = { Authorization: 'Bearer test-token' };
    assert.equal((await fetch(`${url}/api/jobs`, { method: 'POST', headers, body: uploadForm({ nope: true }) })).status, 400);

    const unsafe = testManifest();
    unsafe.assets.focusVideo = '../focus-video.mp4';
    assert.equal((await fetch(`${url}/api/jobs`, { method: 'POST', headers, body: uploadForm(unsafe) })).status, 400);

    const missing = await fetch(`${url}/api/jobs`, { method: 'POST', headers, body: uploadForm(manifest, { 'assets/focus-video.mp4': 'video' }) });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /Missing source files/);
  });
});

test('render job upload persists manifest and files inside the isolated job folder', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));

  await withServer(worker.app, async (url) => {
    const headers = { Authorization: 'Bearer test-token' };
    const manifest = testManifest();
    const response = await fetch(`${url}/api/jobs`, {
      method: 'POST',
      headers,
      body: uploadForm(manifest, {
        'assets/focus-video.mp4': 'focus',
        'assets/break-video.mp4': 'break',
        'assets/focus-audio.mp3': 'audio',
        'assets/CormorantGaramond-Italic.ttf': 'font',
      }),
    });
    assert.equal(response.status, 201);
    const job = await response.json();
    assert.equal(job.state, 'queued');
    assert.equal(JSON.parse(fs.readFileSync(path.join(worker.root, 'jobs', `${job.id}.json`), 'utf8')).manifestPath.endsWith('manifest.json'), true);
    assert.equal(fs.existsSync(path.join(worker.root, 'uploads', job.id, 'assets', 'focus-video.mp4')), true);
    assert.equal(fs.existsSync(path.join(worker.root, 'uploads', job.id, 'manifest.json')), true);
  });
});

test('logical asset resolution stays inside the job upload directory', (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  const job = worker.store.createJob({ state: 'queued', manifest: testManifest(), uploadDir: path.join(worker.root, 'uploads', 'job') });

  const resolved = resolveRenderManifest(worker.config, job);
  assert.equal(resolved.focusVideoPath.endsWith(path.join('assets', 'focus-video.mp4')), true);

  const unsafe = { ...job, manifest: testManifest() };
  unsafe.manifest.assets.breakVideo = 'assets/../outside.mp4';
  assert.throws(() => resolveRenderManifest(createConfig({ WORKER_ROOT: worker.root, WORKER_API_TOKEN: 'test-token' }), unsafe), /Unsafe asset path/);
});

test('queue runs only one render at a time', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  worker.store.createJob({ state: 'queued' });
  worker.store.createJob({ state: 'queued' });
  let active = 0;
  let maxActive = 0;
  const queue = createQueueManager(worker.store, {
    renderJob: async (jobId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      worker.store.updateJob(jobId, { state: 'completed' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    },
  });

  await Promise.all([queue.drain(), queue.drain()]);

  assert.equal(maxActive, 1);
  assert.equal(worker.store.listJobs().filter((job) => job.state === 'completed').length, 2);
});
