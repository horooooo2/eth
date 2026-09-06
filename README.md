# 巨鲸追踪与宏观共振仪表盘（WhaleTracker）

个人使用的加密宏观 + 巨鲸仓位聚合仪表盘。前端 Vue 3，后端 Express，数据缓存 5 分钟。

## 方案是否可行

**可行，适合作为个人仪表盘。** 前后端分离、文件缓存、腾讯云轻量部署、月成本远低于 200 元，这些判断都成立。但原方案有几处不改会空转，代码里已经按下面方式修正。

### 必须正视的缺口

1. **预设巨鲸是 Hyperliquid 合约交易员，不是普通链上转账地址。**  
   `cryptocurrency.cv/api/whale-alerts` 给的是全网大额转账，**不会**告诉你 `58bro.eth` 现在做多还是做空。左栏「当前方向」如果只靠 whale-alerts，会永远是观望。  
   **处理：** 后端同时请求 Hyperliquid 公开 Info API（`clearinghouseState` + `userFills`），用净仓位判断做多 / 做空 / 观望，成交列表优先展示这些地址 ≥ 10 万美元的 HL 成交。

2. **ENS 名称无法直接过滤交易。**  
   接口返回的是 `0x` 地址。配置文件增加了 `address` 字段。已填入：
   - `58bro.eth` → `0x418AA6Bf98a2b2BC93779f810330d88cDe488888`
   - `pension-usdt.eth` → `0x0ddf9bae2af4b874b96d287a5ad42eb47138a902`
   - `回撤低b0d2` 方案里只有截断地址 `0x0925…32b0d2`，默认关闭，请在「配置地址」里补全后再启用。

3. **`cryptocurrency.cv` 并非永远免费可用。**  
   文档写免 Key，但 `whale-alerts` 在部分环境会返回 **402**。  
   **处理：** 自动尝试 `fcn.dev` 同源接口；失败时仪表盘仍可用 HL 仓位/成交 + 新闻，并在顶部给出警告，不会整页崩溃。

4. **金十快讯需要请求头。**  
   `flash-api.jin10.com/get_flash_list` 没有 `x-app-id` / `x-version` 经常 502。后端已带上公开站点使用的请求头，并增加 CryptoCompare 新闻兜底。金十是非官方接口，随时可能失效，不要当成生产 SLA。

5. **共振信号只能是「人工宏观判断 × 巨鲸仓位方向」。**  
   输入框不会做 NLP。你选偏多/偏空后，前端统计 ≥ 2 个已启用巨鲸方向一致才亮横幅。这和方案里的手动模式一致，不要误当成自动宏观解读。

### 成本

腾讯云轻量 99 元/年套餐 + 可选域名，月均远低于 15 元，也远低于 200 元上限。没有付费 API Key。

## 本地运行

需要 Node.js 18+。

```bash
# 后端
cd whale-tracker-backend
npm install
npm run dev

# 前端（另开一个终端）
cd whale-tracker-frontend
npm install
npm run dev
```

浏览器打开 http://localhost:5173  
Vite 已把 `/api` 代理到 `http://localhost:3000`。

## 交付功能

- 巨鲸仓位方向 + 大额成交/转账表格
- 加密新闻与金十快讯聚合，关键词高亮
- 手动宏观方向 × 巨鲸共识共振横幅
- 配置弹窗增删监控地址、关键词
- 深色 / 浅色主题
- 打开页面拉取数据，之后每 5 分钟刷新；缓存超过 5 分钟显示「数据已过期」

不包含：自动交易、多用户登录、RSI/MACD。
