const fs = require("node:fs");
const path = require("node:path");
const { executeRenderPipeline } = require("../../../shared/renderPipeline");

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
    fontItalicPath: resolveInside(uploadDir, assets.fontItalic),
    tempDir,
    outDir,
    finalFilename: path.basename(
      job.manifest.config.finalFilename || `render-${job.id}.mp4`,
    ),
    keepTempFiles: false,
    ffmpegProgress: true,
  };
}

async function renderJob({ config, store, jobId }) {
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
    const finalPath = await executeRenderPipeline(manifest, onProgress);
    if (!fs.existsSync(finalPath))
      throw new Error("FFmpeg completed but output file was not created");
    const stats = fs.statSync(finalPath);
    store.updateJob(jobId, {
      state: "completed",
      progress: 100,
      currentStep: "Completed",
      outputPath: finalPath,
      outputSizeBytes: stats.size,
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
      completedAt: new Date().toISOString(),
    });
  }
}

module.exports = {
  assertSafeAssetPath,
  validateManifest,
  requiredLogicalPaths,
  resolveRenderManifest,
  renderJob,
};
