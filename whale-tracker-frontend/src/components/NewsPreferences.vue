<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { fetchRadarCatalog, type TradFiMarketSymbol } from '@/api';
import { radarClient } from '@/utils/radarRealtime';
import { newsWatch, newsWatchFollowsRadar, saveNewsWatch, resetNewsWatch } from '@/utils/newsWatch';
const visible = ref(false), loading = ref(false);
const draft = ref<string[]>([]), query = ref(''), error = ref('');
const catalog = ref<TradFiMarketSymbol[]>([]);
const names = computed(() => new Map(catalog.value.map(a => [a.symbol, a.name])));
const options = computed(() => catalog.value.filter(a => !draft.value.includes(a.symbol) && `${a.symbol} ${a.name}`.toLowerCase().includes(query.value.trim().toLowerCase())).slice(0, 60));
async function open() {
  draft.value = [...newsWatch.value]; query.value = ''; error.value = ''; visible.value = true;
  catalog.value = radarClient.state.value?.catalog || [];
  if (catalog.value.length) return;
  loading.value = true;
  try { catalog.value = (await fetchRadarCatalog()).symbols; } catch { error.value = '标的清单加载失败，请关闭后重试；仍可管理已关注标的。'; }
  finally { loading.value = false; }
}
function add(symbol: string) { if (draft.value.length >= 60) { ElMessage.warning('最多关注 60 个新闻标的'); return; } if (!draft.value.includes(symbol)) draft.value.push(symbol); }
function save() { try { saveNewsWatch(draft.value); visible.value = false; ElMessage.success('新闻标的已保存'); } catch { ElMessage.error('无法保存，请检查浏览器存储权限'); } }
function reset() { try { resetNewsWatch(); visible.value = false; ElMessage.success('新闻标的已恢复跟随其他模块'); } catch { ElMessage.error('无法保存，请检查浏览器存储权限'); } }
</script>
<template>
  <div class="news-prefs">
    <slot :open="open"><button @click="open">新闻标的管理</button></slot>
    <el-dialog v-model="visible" title="新闻标的管理" width="min(620px,94vw)" append-to-body>
      <p class="hint">{{ newsWatchFollowsRadar ? '当前跟随雷达与虚拟币关注列表。保存后使用新闻独立列表。' : '当前为新闻独立列表，不影响雷达和虚拟币的关注设置。' }}</p>
      <div class="selected-label">已选择 {{ draft.length }} / 60 <small>可清空，仅查看综合资讯</small></div>
      <div class="chips"><el-tag v-for="symbol in draft" :key="symbol" closable @close="draft = draft.filter(s => s !== symbol)">{{ names.get(symbol) || symbol.replace(/USDT$/, '') }}</el-tag></div>
      <el-input v-model="query" placeholder="搜索公司名称或合约代码" clearable aria-label="搜索新闻标的" />
      <p v-if="error" class="hint" role="status">{{ error }}</p>
      <div class="options" aria-label="可添加新闻标的"><span v-if="loading">正在加载标的…</span><button v-for="a in options" :key="a.symbol" @click="add(a.symbol)"><span>{{ a.name }}<small>{{ a.symbol }}</small></span><span>＋</span></button><p v-if="!loading && !options.length">没有匹配的可添加标的</p></div>
      <template #footer><div class="footer"><el-button text @click="reset">恢复跟随关注</el-button><span /><el-button @click="visible = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></div></template>
    </el-dialog>
  </div>
</template>
<style scoped>
.news-prefs{width:100%;border-top:1px solid var(--border)}.hint{font-size:12px;color:var(--muted);line-height:1.8}.selected-label{font-size:13px;margin:18px 0 10px}.selected-label small{color:var(--muted);margin-left:10px}.chips{display:flex;flex-wrap:wrap;gap:8px;max-height:150px;overflow:auto;margin-bottom:18px}.options{display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:270px;overflow:auto;margin-top:12px}.options button{border:1px solid var(--border);border-radius:6px;background:var(--panel);padding:10px;color:var(--text);display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;cursor:pointer}.options button:hover{border-color:var(--accent)}.options small{display:block;color:var(--muted);font-size:10px;margin-top:4px}.footer{display:flex;align-items:center;gap:8px}.footer>span{flex:1}.footer :deep(.el-button){margin-left:0}
</style>
