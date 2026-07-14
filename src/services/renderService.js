const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
let executeRenderPipeline;
try {
  ({ executeRenderPipeline } = require("../shared/renderPipeline"));
} catch (_) {
  ({
    executeRenderPipeline,
  } = require("../../../be/src/shared/renderPipeline"));
}

const SAFE_ASSET = /^assets\/[A-Za-z0-9._ -]+$/;

function assertSafeAssetPath(logicalPath) {
  if (
    typeof logicalPath !== "string" ||
    !SAFE_ASSET.test(logicalPath) ||
    logicalPath.includes("..")
  ) {
    throw new Error(`Unsafe asset path: ${logicalPath}`);
  }
  return logicalPath;
}

function resolveInside(root, logicalPath) {
  assertSafeAssetPath(logicalPath);
  const resolved = path.resolve(root, logicalPath);
  const safeRoot = path.resolve(root);
  if (resolved !== safeRoot && resolved.startsWith(`${safeRoot}${path.sep}`))
    return resolved;
  throw new Error(`Unsafe asset path: ${logicalPath}`);
}

function validateManifest(manifest) {
  if (
    !manifest ||
    manifest.version !== 1 ||
    !manifest.config ||
    !manifest.assets
  )
    throw new Error("Invalid render manifest");
  for (const key of ["focusVideo", "breakVideo", "fontItalic"])
    assertSafeAssetPath(manifest.assets[key]);
  if (manifest.assets.sessionBell)
    assertSafeAssetPath(manifest.assets.sessionBell);
  if (
    !Array.isArray(manifest.assets.audioPlan) ||
    manifest.assets.audioPlan.length < 1
  )
    throw new Error("Invalid render manifest");
  for (const segment of manifest.assets.audioPlan) {
    if (!["focus", "break"].includes(segment.type))
      throw new Error("Invalid render manifest");
    if (!Number.isInteger(segment.sessionIndex) || segment.sessionIndex < 1)
      throw new Error("Invalid render manifest");
    if (
      !Number.isFinite(Number(segment.durationSeconds)) ||
      Number(segment.durationSeconds) <= 0
    )
      throw new Error("Invalid render manifest");
    assertSafeAssetPath(segment.audioPath);
  }
}

function requiredLogicalPaths(manifest) {
  const paths = [
    manifest.assets.focusVideo,
    manifest.assets.breakVideo,
    manifest.assets.fontItalic,
  ];
  if (manifest.assets.sessionBell) paths.push(manifest.assets.sessionBell);
  for (const segment of manifest.assets.audioPlan)
    paths.push(segment.audioPath);
  return [...new Set(paths)];
}

function resolveRenderManifest(config, job) {
  validateManifest(job.manifest);
  const uploadDir =
    job.uploadDir || path.join(config.directories.uploads, job.id);
  const tempDir = job.tempDir || path.join(config.directories.temp, job.id);
  const outDir = job.outputDir || path.join(config.directories.outputs, job.id);
  const assets = job.manifest.assets;
  const fontItalicPath = resolveInside(uploadDir, assets.fontItalic);
  if (!fs.existsSync(fontItalicPath)) {
    throw new Error(`Uploaded font file is missing: ${assets.fontItalic}`);
  }
  return {
    focusVideoPath: resolveInside(uploadDir, assets.focusVideo),
    breakVideoPath: resolveInside(uploadDir, assets.breakVideo),
    timerTextColor: job.manifest.config.timerTextColor,
    isPreview: job.manifest.config.isPreview === true,
    sessionCount: Number(job.manifest.config.sessionCount || 1),
    audioPlan: assets.audioPlan.map((segment) => ({
      ...segment,
      audioPath: resolveInside(uploadDir, segment.audioPath),
    })),
    bellPath: assets.sessionBell
      ? resolveInside(uploadDir, assets.sessionBell)
      : null,
    fontItalicPath,
    tempDir,
    outDir,
    finalFilename: path.basename(
      job.manifest.config.finalFilename || `render-${job.id}.mp4`,
    ),
    keepTempFiles: false,
    ffmpegProgress: true,
  };
}

function expectedDuration(manifest) {
  return (manifest?.assets?.audioPlan || []).reduce(
    (total, segment) => total + Number(segment.durationSeconds || 0),
    0,
  );
}

function runFfprobe(outputPath, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      outputPath,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(`ffprobe failed: ${stderr || `exit ${code}`}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`ffprobe returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function validateRenderedOutput({
  outputPath,
  expectedDurationSeconds,
  expectAudio,
  spawnImpl = spawn,
}) {
  if (!outputPath || !fs.existsSync(outputPath))
    throw new Error("Rendered output file is missing");
  const stats = fs.statSync(outputPath);
  if (stats.size <= 0) throw new Error("Rendered output file is empty");
  const probe = await runFfprobe(outputPath, spawnImpl);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("Rendered output has no video stream");
  const duration = Number(probe.format?.duration || video.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Rendered output duration cannot be read");
  const width = Number(video.width);
  const height = Number(video.height);
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0
  )
    throw new Error("Rendered output video dimensions are invalid");
  if (!video.codec_name)
    throw new Error("Rendered output video codec is missing");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (expectAudio && !audio)
    throw new Error("Rendered output has no audio stream");
  if (expectedDurationSeconds > 0) {
    const tolerance = Math.max(2, expectedDurationSeconds * 0.05);
    if (Math.abs(duration - expectedDurationSeconds) > tolerance)
      throw new Error(
        `Rendered output duration ${duration}s differs from expected ${expectedDurationSeconds}s`,
      );
  }
  return {
    succeeded: true,
    sizeBytes: stats.size,
    durationSeconds: duration,
    expectedDurationSeconds,
    width,
    height,
    videoCodec: video.codec_name,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name || null,
  };
}

async function renderJob({
  config,
  store,
  jobId,
  executeRenderPipelineImpl = executeRenderPipeline,
  spawnImpl = spawn,
}) {
  const started = store.updateJob(jobId, {
    state: "rendering",
    progress: 0,
    currentStep: "Starting remote render",
    startedAt: new Date().toISOString(),
  });
  const manifest = resolveRenderManifest(config, started);
  let lastPersistedAt = 0;
  const onProgress = (progress, step, extra = {}) => {
    const now = Date.now();
    if (progress === 100 || now - lastPersistedAt >= 1000) {
      lastPersistedAt = now;
      store.updateJob(jobId, {
        state: "rendering",
        progress,
        currentStep: step,
        currentTimeSeconds: extra.currentTimeSeconds,
      });
    }
  };
  try {
    const finalPath = await executeRenderPipelineImpl(manifest, onProgress);
    store.updateJob(jobId, {
      state: "validating",
      progress: 99,
      currentStep: "Validating",
      outputPath: finalPath,
    });
    const validation = await validateRenderedOutput({
      outputPath: finalPath,
      expectedDurationSeconds: expectedDuration(started.manifest),
      expectAudio: (started.manifest?.assets?.audioPlan || []).length > 0,
      spawnImpl,
    });
    store.updateJob(jobId, {
      state: "completed",
      progress: 100,
      currentStep: "Completed",
      outputPath: finalPath,
      outputSizeBytes: validation.sizeBytes,
      validation,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    fs.writeFileSync(
      path.join(config.directories.logs, `${jobId}.log`),
      `${new Date().toISOString()}\n${error.stack || error.message}\n`,
      "utf8",
    );
    store.updateJob(jobId, {
      state: "failed",
      currentStep: "Failed",
      errorMessage: error.message,
      validation: { succeeded: false, errorMessage: error.message },
      completedAt: new Date().toISOString(),
    });
  }
}

module.exports = {
  assertSafeAssetPath,
  validateManifest,
  requiredLogicalPaths,
  resolveRenderManifest,
  validateRenderedOutput,
  renderJob,
};
