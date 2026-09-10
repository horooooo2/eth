'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const backendPublic = path.join(__dirname, '..', 'public');
const frontendSrc = path.join(__dirname, '..', '..', 'whale-tracker-frontend', 'src');

test('old static admin URLs redirect into /#/console', () => {
  const dataHtml = fs.readFileSync(path.join(backendPublic, 'data.html'), 'utf8');
  const cfgHtml = fs.readFileSync(path.join(backendPublic, 'strategy-config.html'), 'utf8');
  assert.match(dataHtml, /\/#\/console\/data/);
  assert.match(cfgHtml, /\/#\/console\/strategy-config/);
  assert.match(dataHtml, /location\.replace/);
  assert.match(cfgHtml, /location\.replace/);
});

test('main site hash route stays DesktopApp; console is a sibling route', () => {
  const router = fs.readFileSync(path.join(frontendSrc, 'router', 'index.ts'), 'utf8');
  assert.match(router, /path: '\/',\s*\n\s*name: 'desktop',\s*\n\s*component: \(\) => import\('@\/views\/DesktopApp\.vue'\)/s);
  assert.match(router, /path: '\/console'/);
  assert.match(router, /path: 'data'/);
  assert.match(router, /path: 'strategy-config'/);
  assert.match(router, /path: '\/data\.html', redirect: '\/console\/data'/);
  assert.match(router, /path: '\/strategy-config\.html', redirect: '\/console\/strategy-config'/);
  assert.match(router, /path: '\/consolestrategy-config\.html', redirect: '\/console\/strategy-config'/);
  assert.doesNotMatch(router, /path: '\/',\s*\n\s*redirect: '\/console'/s);
});

test('main site login wall and whale AI workspace stay in DesktopApp', () => {
  const desktop = fs.readFileSync(path.join(frontendSrc, 'views', 'DesktopApp.vue'), 'utf8');
  assert.match(desktop, /WhaleAiWorkspace/);
  assert.match(desktop, /login-gate/);
  assert.match(desktop, /请先登录后进入网站/);
});

test('console nav only exposes migrated admin pages', () => {
  const layout = fs.readFileSync(path.join(frontendSrc, 'views', 'console', 'ManagementLayout.vue'), 'utf8');
  assert.match(layout, /交易系统管理后台/);
  assert.match(layout, /数据看板/);
  assert.match(layout, /策略配置/);
  assert.match(layout, /to="\/console\/data"/);
  assert.match(layout, /to="\/console\/strategy-config"/);
  assert.doesNotMatch(layout, /策略控制/);
  assert.doesNotMatch(layout, /运行日志/);
  assert.doesNotMatch(layout, /iframe/i);
});
