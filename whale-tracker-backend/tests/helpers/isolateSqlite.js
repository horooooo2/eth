'use strict';

/**
 * Point Node tests at a unique temp SQLite file and delete it on exit.
 * Must be required before any module that calls getDb().
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const id = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `whale-test-${id}-`));
const file = path.join(dir, `whale-${id}.db`);
process.env.SQLITE_PATH = file;

const { closeDb } = require('../../lib/db');

function cleanup() {
  try {
    closeDb();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

process.on('exit', cleanup);

module.exports = { SQLITE_PATH: file, cleanup, dir };
