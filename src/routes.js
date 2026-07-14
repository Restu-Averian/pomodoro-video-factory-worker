const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const multer = require("multer");
const { JOB_ID } = require("./stores/jobStore");
const {
  validateManifest,
  requiredLogicalPaths,
} = require("./services/renderService");

function logUpload(jobId, message, details = {}) {
  console.log("[worker-upload]", { jobId, message, ...details });
}

function authenticated(config) {
  return (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    const received = Buffer.from(match?.[1] || "");
    const expected = Buffer.from(config.token);
    if (
      !match ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      return res.status(401).json({ error: "Unauthorized" });
    console.log("[worker-upload]", {
      message: "authentication passed",
      method: req.method,
      path: req.originalUrl,
    });
    next();
  };
}

function validJobId(req, res, next) {
  if (!JOB_ID.test(req.params.jobId))
    return res.status(400).json({ error: "Invalid job ID" });
  next();
}

function isInside(root, filePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  return (
    resolvedFile !== resolvedRoot &&
    resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function safeDispositionName(filename) {
  return path.basename(filename || "render.mp4").replace(/[\r\n"]/g, "_");
}

function createRoutes({ config, store, queue, availability }) {
  const router = express.Router();
  const storage = multer.diskStorage({
    destination(req, file, callback) {
      callback(null, req.remoteJob.incomingDir);
    },
    filename(req, file, callback) {
      callback(
        null,
        `${Date.now()}-${req.remoteJob.receivedFiles++}-${path.basename(file.originalname || "asset")}`,
      );
    },
  });
  const upload = multer({
    storage,
    fileFilter(req, file, callback) {
      if (file.fieldname !== "assets")
        return callback(new Error(`Unexpected file field: ${file.fieldname}`));
      callback(null, true);
    },
  }).fields([{ name: "assets" }]);

  router.use(authenticated(config));

  router.get("/status", (_req, res) => {
    const status = queue.getStatus();
    res.json({
      activeJobId: status.activeJobId,
      activeJob: status.activeJobId ? store.getJob(status.activeJobId) : null,
      queuedJobs: status.queuedJobs,
      queuedJobCount: status.queuedJobCount,
      ready:
        config.maxActiveRenders === 1 &&
        availability.ffmpeg &&
        availability.ffprobe,
      ffmpegAvailable: availability.ffmpeg,
      ffprobeAvailable: availability.ffprobe,
      renderUploadSupported: true,
    });
  });
  router.get("/jobs", (_req, res) =>
    res.json({ jobs: store.listJobs(), ...queue.getStatus() }),
  );
  router.get("/jobs/:jobId", validJobId, (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  });
  router.get("/jobs/:jobId/output", validJobId, (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.state !== "completed" || job.validation?.succeeded !== true)
      return res.status(409).json({ error: "Job output is not ready" });
    const outputPath = job.outputPath;
    const outputDir =
      job.outputDir || path.join(config.directories.outputs, job.id);
    if (
      !outputPath ||
      !isInside(config.directories.outputs, outputPath) ||
      !isInside(outputDir, outputPath) ||
      !fs.existsSync(outputPath)
    )
      return res.status(409).json({ error: "Job output is unavailable" });
    const stats = fs.statSync(outputPath);
    if (!stats.isFile() || stats.size <= 0)
      return res.status(409).json({ error: "Job output is unavailable" });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stats.size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeDispositionName(outputPath)}"`,
    );
    const stream = fs.createReadStream(outputPath);
    let closed = false;
    req.on("close", () => {
      closed = true;
      stream.destroy();
    });
    stream.on("error", (error) => {
      if (!closed && !res.headersSent)
        return res.status(500).json({ error: error.message });
      if (!closed) res.destroy(error);
    });
    stream.pipe(res);
  });
  router.post(
    "/jobs",
    (req, res, next) => {
      logUpload(null, "request received");
      const job = store.createJob({
        kind: "render",
        state: "receiving",
        progress: 0,
        currentStep: "Receiving sources",
      });
      const uploadDir = path.join(config.directories.uploads, job.id);
      const incomingDir = path.join(uploadDir, "incoming");
      const tempDir = path.join(config.directories.temp, job.id);
      const outputDir = path.join(config.directories.outputs, job.id);
      for (const directory of [
        path.join(uploadDir, "assets"),
        incomingDir,
        tempDir,
        outputDir,
      ])
        fs.mkdirSync(directory, { recursive: true });
      req.remoteJob = {
        ...store.updateJob(job.id, { uploadDir, tempDir, outputDir }),
        incomingDir,
        receivedFiles: 0,
      };
      req.on("aborted", () => {
        logUpload(job.id, "request aborted");
        store.updateJob(job.id, {
          state: "failed",
          currentStep: "Upload aborted",
          errorMessage: "Request aborted during upload",
        });
      });
      next();
    },
    (req, res, next) => {
      logUpload(req.remoteJob.id, "multipart parsing started");
      upload(req, res, (error) => {
        if (error) {
          logUpload(req.remoteJob?.id || null, "parser error", {
            error: error.message,
          });
          if (req.remoteJob)
            store.updateJob(req.remoteJob.id, {
              state: "failed",
              currentStep: "Upload failed",
              errorMessage: error.message,
            });
          return res.status(400).json({ error: error.message });
        }
        next();
      });
    },
    (req, res) => {
      try {
        const manifest = JSON.parse(req.body.manifest || "null");
        logUpload(req.remoteJob.id, "manifest received");
        validateManifest(manifest);
        const required = requiredLogicalPaths(manifest);
        const files = req.files?.assets || [];
        const missing = required.slice(files.length);
        if (missing.length)
          throw new Error(`Missing source files: ${missing.join(", ")}`);
        if (files.length > required.length)
          throw new Error(
            `Unexpected source files: ${files.length - required.length}`,
          );
        required.forEach((logicalPath, index) => {
          const target = path.join(req.remoteJob.uploadDir, logicalPath);
          fs.renameSync(files[index].path, target);
          logUpload(req.remoteJob.id, "file received", {
            logicalPath,
            bytes: files[index].size,
          });
        });
        fs.rmSync(req.remoteJob.incomingDir, { recursive: true, force: true });
        const manifestPath = path.join(
          req.remoteJob.uploadDir,
          "manifest.json",
        );
        fs.writeFileSync(
          manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
        const job = store.updateJob(req.remoteJob.id, {
          state: "queued",
          progress: 0,
          currentStep: "Queued",
          manifest,
          manifestPath,
        });
        queue.enqueue();
        logUpload(req.remoteJob.id, "job persistence success");
        res.status(201).json(job);
      } catch (error) {
        logUpload(req.remoteJob.id, "validation failure", {
          error: error.message,
        });
        store.updateJob(req.remoteJob.id, {
          state: "failed",
          currentStep: "Upload rejected",
          errorMessage: error.message,
        });
        res.status(400).json({ error: error.message });
      }
    },
  );
  router.post("/jobs/test", (_req, res) =>
    res.status(201).json(store.createJob({ kind: "test", state: "queued" })),
  );
  router.delete("/jobs/:jobId", validJobId, (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (
      !(
        job.kind === "test" ||
        ["failed", "cancelled", "interrupted", "delivered", "cleaned"].includes(
          job.state,
        )
      )
    )
      return res
        .status(409)
        .json({ error: "Job cannot be deleted in its current state" });
    store.removeJob(job.id);
    res.status(204).end();
  });
  return router;
}

module.exports = { createRoutes };
