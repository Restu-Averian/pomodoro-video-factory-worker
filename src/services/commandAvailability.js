const { spawn } = require('node:child_process');

function commandAvailable(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['-version'], { shell: false, stdio: 'ignore' });
    const timeout = setTimeout(() => child.kill(), 5000);
    child.once('error', () => { clearTimeout(timeout); resolve(false); });
    child.once('close', (code) => { clearTimeout(timeout); resolve(code === 0); });
  });
}

module.exports = { commandAvailable };
