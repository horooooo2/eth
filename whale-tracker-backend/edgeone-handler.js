/**
 * EdgeOne Pages Cloud Function 入口。
 * 必须导出 onRequest / onRequestGet，直传部署靠这个识别函数。
 */
const {
  onRequest,
  onRequestGet,
  onRequestPost,
  onRequestPut,
  onRequestDelete,
  onRequestOptions,
} = require('./lib/apiGateway');

module.exports = {
  onRequest,
  onRequestGet,
  onRequestPost,
  onRequestPut,
  onRequestDelete,
  onRequestOptions,
};
