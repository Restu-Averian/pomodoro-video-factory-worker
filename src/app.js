const express = require('express');
const os = require('node:os');
const { createRoutes } = require('./routes');

function createApp({ config, store, queue, commandAvailable }) {
  const app = express();
  const availability = { ffmpeg: false, ffprobe: false };
  const refreshAvailability = async () => {
    [availability.ffmpeg, availability.ffprobe] = await Promise.all([commandAvailable('ffmpeg'), commandAvailable('ffprobe')]);
    return availability;
  };
  app.get('/health', async (_req, res) => {
    await refreshAvailability();
    const status = queue.getStatus();
    res.json({ ok: true, service: 'niititu-render-worker', version: '0.1.0', timestamp: new Date().toISOString(), platform: process.platform, hostname: os.hostname(), ffmpegAvailable: availability.ffmpeg, ffprobeAvailable: availability.ffprobe, activeJobId: status.activeJobId, queuedJobCount: status.queuedJobCount });
  });
  app.use('/api', createRoutes({ config, store, queue, availability }));
  return app;
}

module.exports = { createApp };
