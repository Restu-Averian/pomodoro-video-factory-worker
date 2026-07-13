require('dotenv').config();
const { createConfig } = require('./config');
const { createJobStore } = require('./stores/jobStore');
const { createQueueManager } = require('./services/queueManager');
const { commandAvailable } = require('./services/commandAvailability');
const { renderJob } = require('./services/renderService');
const { createApp } = require('./app');

const config = createConfig();
const store = createJobStore(config);
store.loadJobsOnStartup();
const queue = createQueueManager(store, { renderJob: (jobId) => renderJob({ config, store, jobId }) });
const app = createApp({ config, store, queue, commandAvailable });
queue.enqueue();

app.listen(config.port, config.host, () => console.log(`Worker listening on http://${config.host}:${config.port}`));
