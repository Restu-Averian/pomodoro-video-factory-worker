const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfig } = require('../src/config');
const { createJobStore } = require('../src/stores/jobStore');
const { createQueueManager } = require('../src/services/queueManager');
const { createApp } = require('../src/app');
const { EventEmitter } = require('node:events');
const { resolveRenderManifest, renderJob, validateRenderedOutput } = require('../src/services/renderService');

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
  const uploadDir = path.join(worker.root, 'uploads', 'job');
  fs.mkdirSync(path.join(uploadDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'assets', 'CormorantGaramond-Italic.ttf'), 'font');
  const job = worker.store.createJob({ state: 'queued', manifest: testManifest(), uploadDir });

  const resolved = resolveRenderManifest(worker.config, job);
  assert.equal(resolved.focusVideoPath.endsWith(path.join('assets', 'focus-video.mp4')), true);

  const unsafe = { ...job, manifest: testManifest() };
  unsafe.manifest.assets.breakVideo = 'assets/../outside.mp4';
  assert.throws(() => resolveRenderManifest(createConfig({ WORKER_ROOT: worker.root, WORKER_API_TOKEN: 'test-token' }), unsafe), /Unsafe asset path/);
});

test('render manifest reports a clear error when the uploaded font is missing', (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  const uploadDir = path.join(worker.root, 'uploads', 'job');
  fs.mkdirSync(path.join(uploadDir, 'assets'), { recursive: true });
  const job = worker.store.createJob({ state: 'queued', manifest: testManifest(), uploadDir });

  assert.throws(
    () => resolveRenderManifest(worker.config, job),
    /Uploaded font file is missing: assets\/CormorantGaramond-Italic\.ttf/,
  );
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

test('output endpoint rejects unauthenticated, unknown, incomplete, and unsafe jobs', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  const outputFile = path.join(worker.config.directories.outputs, 'outside.mp4');
  fs.writeFileSync(outputFile, 'video');
  const queued = worker.store.createJob({ kind: 'render', state: 'queued' });
  const unsafe = worker.store.createJob({
    kind: 'render',
    state: 'completed',
    validation: { succeeded: true },
    outputPath: outputFile,
    outputDir: path.join(worker.config.directories.outputs, unsafeJobDirName()),
  });

  await withServer(worker.app, async (url) => {
    const headers = { Authorization: 'Bearer test-token' };
    assert.equal((await fetch(`${url}/api/jobs/${queued.id}/output`)).status, 401);
    assert.equal((await fetch(`${url}/api/jobs/${queued.id}/output`, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
    assert.equal((await fetch(`${url}/api/jobs/00000000-0000-4000-8000-000000000000/output`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/api/jobs/${queued.id}/output`, { headers })).status, 409);
    assert.equal((await fetch(`${url}/api/jobs/${unsafe.id}/output`, { headers })).status, 409);
  });
});

test('output endpoint streams a completed validated file', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  const outputDir = path.join(worker.config.directories.outputs, 'job-output');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'final test.mp4');
  fs.writeFileSync(outputPath, 'remote-video');
  const job = worker.store.createJob({
    kind: 'render',
    state: 'completed',
    validation: { succeeded: true },
    outputDir,
    outputPath,
  });

  await withServer(worker.app, async (url) => {
    const response = await fetch(`${url}/api/jobs/${job.id}/output`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength('remote-video')));
    assert.match(response.headers.get('content-disposition'), /filename="final test\.mp4"/);
    assert.equal(await response.text(), 'remote-video');
  });
});

function unsafeJobDirName() {
  return 'nested';
}

function fakeFfprobe(stdout, exitCode = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child;
  };
}

test('ffprobe validation accepts a usable rendered output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niititu-validation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'final.mp4');
  fs.writeFileSync(outputPath, 'video');
  const metadata = {
    format: { duration: '15.1' },
    streams: [
      { codec_type: 'video', width: 1920, height: 1080, codec_name: 'h264' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  };

  const validation = await validateRenderedOutput({
    outputPath,
    expectedDurationSeconds: 15,
    expectAudio: true,
    spawnImpl: fakeFfprobe(JSON.stringify(metadata)),
  });

  assert.equal(validation.succeeded, true);
  assert.equal(validation.width, 1920);
  assert.equal(validation.height, 1080);
  assert.equal(validation.videoCodec, 'h264');
  assert.equal(validation.audioCodec, 'aac');
});

test('validation failure marks a worker render job failed', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  const uploadDir = path.join(worker.root, 'uploads', 'job');
  fs.mkdirSync(path.join(uploadDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'assets', 'CormorantGaramond-Italic.ttf'), 'font');
  const outputDir = path.join(worker.root, 'outputs', 'job');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'remote-test.mp4');
  fs.writeFileSync(outputPath, 'video');
  const job = worker.store.createJob({
    state: 'queued',
    manifest: testManifest(),
    uploadDir,
    outputDir,
    tempDir: path.join(worker.root, 'temp', 'job'),
  });

  await renderJob({
    config: worker.config,
    store: worker.store,
    jobId: job.id,
    executeRenderPipelineImpl: async () => outputPath,
    spawnImpl: fakeFfprobe(JSON.stringify({ format: { duration: '15' }, streams: [] })),
  });

  const failed = worker.store.getJob(job.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.currentStep, 'Failed');
  assert.match(failed.errorMessage, /video stream/i);
  assert.equal(failed.validation.succeeded, false);
});

test('successful validation marks a worker render job completed', async (t) => {
  const worker = makeWorker();
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  const uploadDir = path.join(worker.root, 'uploads', 'job');
  fs.mkdirSync(path.join(uploadDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'assets', 'CormorantGaramond-Italic.ttf'), 'font');
  const outputDir = path.join(worker.root, 'outputs', 'job');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'remote-test.mp4');
  fs.writeFileSync(outputPath, 'video');
  const job = worker.store.createJob({
    state: 'queued',
    manifest: testManifest(),
    uploadDir,
    outputDir,
    tempDir: path.join(worker.root, 'temp', 'job'),
  });
  const metadata = {
    format: { duration: '15' },
    streams: [
      { codec_type: 'video', width: 1920, height: 1080, codec_name: 'h264' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  };

  await renderJob({
    config: worker.config,
    store: worker.store,
    jobId: job.id,
    executeRenderPipelineImpl: async () => outputPath,
    spawnImpl: fakeFfprobe(JSON.stringify(metadata)),
  });

  const completed = worker.store.getJob(job.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.currentStep, 'Completed');
  assert.equal(completed.validation.succeeded, true);
  assert.equal(completed.outputPath, outputPath);
});
