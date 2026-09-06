/**
 * EdgeOne Pages Cloud Function 入口（打包后放到 cloud-functions/api/[[default]].js）。
 * 不要 app.listen：平台会接管请求。
 */
const { createApp } = require('./lib/createApp');

module.exports = createApp({ prefixes: ['', '/api'] });
