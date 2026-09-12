'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const backendPublic = path.join(__dirname, '..', 'public');
const frontendSrc = path.join(__dirname, '..', '..', 'whale-tracker-frontend', 'src');

test('old static admin URL redirects into /#/console', () => {
  const dataHtml = fs.readFileSync(path.join(backendPublic, 'data.html'), 'utf8');
  assert.match(dataHtml, /\/#\/console\/data/);
  assert.match(dataHtml, /location\.replace/);
});

test('strategy-config static shim is gone', () => {
  assert.equal(fs.existsSync(path.join(backendPublic, 'strategy-config.html')), false);
  assert.equal(fs.existsSync(path.join(backendPublic, 'strategy-config.js')), false);
});

test('main site hash route stays DesktopApp; console is a sibling route', () => {
  const router = fs.readFileSync(path.join(frontendSrc, 'router', 'index.ts'), 'utf8');
  assert.match(router, /path: '\/',\s*\n\s*name: 'desktop',\s*\n\s*component: \(\) => import\('@\/views\/DesktopApp\.vue'\)/s);
  assert.match(router, /path: '\/console'/);
  assert.match(router, /path: 'data'/);
  assert.match(router, /path: '\/data\.html', redirect: '\/console\/data'/);
  assert.doesNotMatch(router, /strategy-config/);
  assert.doesNotMatch(router, /path: '\/',\s*\n\s*redirect: '\/console'/s);
});

test('main site login wall stays; strategy workspace is gone', () => {
  const desktop = fs.readFileSync(path.join(frontendSrc, 'views', 'DesktopApp.vue'), 'utf8');
  assert.match(desktop, /login-gate/);
  assert.match(desktop, /请先登录后进入网站/);
  assert.doesNotMatch(desktop, /WhaleAiWorkspace/);
  assert.doesNotMatch(desktop, /whale-ai/);
});

test('console nav only exposes the data dashboard', () => {
  const layout = fs.readFileSync(path.join(frontendSrc, 'views', 'console', 'ManagementLayout.vue'), 'utf8');
  assert.match(layout, /数据看板/);
  assert.match(layout, /to="\/console\/data"/);
  assert.doesNotMatch(layout, /策略/);
  assert.doesNotMatch(layout, /iframe/i);
});
