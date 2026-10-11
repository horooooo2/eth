import { ref } from 'vue';
export const validationStatus = ref('查看24小时记录');
export const validationRunning = ref(false);
export const validationCoin = ref('all');
export const validationOpener = { open: null as null | (() => void) };
export function openValidation(coin?:string){
  validationCoin.value=coin || 'all';
  validationOpener.open?.();
}
