import { coinIconCandidates } from './coinIcons';
import bundledAssets from './contractLogoAssets.json';

const domains:Record<string,string>={
  HK1024:'kuaishou.com',HK0992:'lenovo.com',LENOVO:'lenovo.com',HK1211:'byd.com',BYD:'byd.com',HK3690:'meituan.com',HK9992:'popmart.com',POPMART:'popmart.com',GOOG:'google.com',BIDU:'baidu.com',JD:'jd.com',PDD:'pddholdings.com',NIO:'nio.com',LI:'lixiang.com',XPEV:'xpeng.com',BILI:'bilibili.com',NTES:'netease.com',BITO:'proshares.com',SPXL:'direxion.com',SPXS:'direxion.com',TSLL:'direxion.com',NVDL:'graniteshares.com',SMH:'vaneck.com',VXX:'ipathetn.barclays',UVXY:'proshares.com',IWM:'ishares.com',DIA:'ssga.com',SAMSUNG:'samsung.com',SAMSUNGEM:'samsungsem.com',HYUNDAI:'hyundai.com',NAVER:'navercorp.com',LGELECTRONICS:'lge.com',TSM:'tsmc.com',PYPL:'paypal.com',
  KORU:'direxion.com',SOXL:'direxion.com',SOXS:'direxion.com',MUU:'direxion.com',TQQQ:'proshares.com',SQQQ:'proshares.com',EWY:'ishares.com',EWJ:'ishares.com',DDOG:'datadoghq.com',UNITREE:'unitree.com',MEITUAN:'meituan.com',
  WDC:'wd.com',KUAISHOU:'kuaishou.com',HK1810:'mi.com',XIAOMI:'mi.com',
  XAU:'cmegroup.com',XAG:'cmegroup.com',XPT:'cmegroup.com',XPD:'cmegroup.com',CL:'cmegroup.com',WTI:'cmegroup.com',USOIL:'cmegroup.com',XTI:'cmegroup.com',BZ:'ice.com',BRENT:'ice.com',
  QQQ:'invesco.com',SPY:'ssga.com',NVDA:'nvidia.com',AAPL:'apple.com',MSFT:'microsoft.com',AMZN:'amazon.com',AVGO:'broadcom.com',AMD:'amd.com',META:'meta.com',SPCX:'spacex.com',SNDK:'sandisk.com',SKHYNIX:'skhynix.com',TSLA:'tesla.com',INTC:'intel.com',
  MU:'micron.com',GOOGL:'google.com',NFLX:'netflix.com',BABA:'alibaba.com',TENCENT:'tencent.com',HK0700:'tencent.com',ORCL:'oracle.com',ARM:'arm.com',QCOM:'qualcomm.com',DELL:'dell.com',PLTR:'palantir.com',COIN:'coinbase.com',HOOD:'robinhood.com',IBM:'ibm.com',ADBE:'adobe.com',CRM:'salesforce.com',UBER:'uber.com',DIS:'disney.com',NKE:'nike.com',MCD:'mcdonalds.com',WMT:'walmart.com',COST:'costco.com',SHOP:'shopify.com',SONY:'sony.com',ASML:'asml.com',
};
export function contractLogoCandidates(symbol:string,type:string='TRADFI',baseAsset?:string):string[]{
  const base=(baseAsset?.trim()||symbol.trim().replace(/USDT$/i,'')).toUpperCase();
  if(!/^[A-Z0-9]{1,30}$/.test(base))return [];
  const local:Record<string,string>={WDC:'WDC.png',KUAISHOU:'KUAISHOU.ico',HK1024:'KUAISHOU.ico',HK1810:'HK1810.ico',XIAOMI:'HK1810.ico'};
  const assets:Record<string,string>=bundledAssets;
  if(type!=='TRADFI')return [...(assets[`crypto:${base}`]?[assets[`crypto:${base}`]!]:[]),...coinIconCandidates(base)];
  const domain=domains[base];
  return [...new Set([
    ...(local[base]?[`/contract-logos/${local[base]}`]:[]),
    ...(domain&&assets[domain]?[assets[domain]!]:[]),
    ...(domain?[`https://icons.duckduckgo.com/ip3/${domain}.ico`,`https://www.google.com/s2/favicons?domain=${domain}&sz=64`]:[]),
  ])];
}
