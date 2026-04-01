'use strict';

const { spawnSync } = require('child_process');

/**
 * Cross-platform check for whether a CLI command is on PATH.
 * Uses `where` on Windows, `which` everywhere else.
 */
function commandExists(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

module.exports = { commandExists };
