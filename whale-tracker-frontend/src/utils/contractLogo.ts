const domains:Record<string,string>={
  KORU:'direxion.com',SOXL:'direxion.com',SOXS:'direxion.com',MUU:'direxion.com',TQQQ:'proshares.com',SQQQ:'proshares.com',EWY:'ishares.com',EWJ:'ishares.com',DDOG:'datadoghq.com',UNITREE:'unitree.com',MEITUAN:'meituan.com',
  WDC:'wd.com',KUAISHOU:'kuaishou.com',HK1810:'mi.com',XIAOMI:'mi.com',
  XAU:'cmegroup.com',XAG:'cmegroup.com',XPT:'cmegroup.com',XPD:'cmegroup.com',CL:'cmegroup.com',WTI:'cmegroup.com',USOIL:'cmegroup.com',XTI:'cmegroup.com',BZ:'ice.com',BRENT:'ice.com',
  QQQ:'invesco.com',SPY:'ssga.com',NVDA:'nvidia.com',AAPL:'apple.com',MSFT:'microsoft.com',AMZN:'amazon.com',AVGO:'broadcom.com',AMD:'amd.com',META:'meta.com',SPCX:'spacex.com',SNDK:'sandisk.com',SKHYNIX:'skhynix.com',TSLA:'tesla.com',INTC:'intel.com',
  MU:'micron.com',GOOGL:'google.com',NFLX:'netflix.com',BABA:'alibaba.com',TENCENT:'tencent.com',HK0700:'tencent.com',ORCL:'oracle.com',ARM:'arm.com',QCOM:'qualcomm.com',DELL:'dell.com',PLTR:'palantir.com',COIN:'coinbase.com',HOOD:'robinhood.com',IBM:'ibm.com',ADBE:'adobe.com',CRM:'salesforce.com',UBER:'uber.com',DIS:'disney.com',NKE:'nike.com',MCD:'mcdonalds.com',WMT:'walmart.com',COST:'costco.com',SHOP:'shopify.com',SONY:'sony.com',ASML:'asml.com',
};
export function contractLogo(symbol:string,type:string='TRADFI',baseAsset?:string){
  const base=baseAsset||symbol.replace(/USDT$/,'');
  const local:Record<string,string>={WDC:'WDC.png',KUAISHOU:'KUAISHOU.ico',HK1810:'HK1810.ico',XIAOMI:'HK1810.ico'};
  if(type==='TRADFI'&&local[base])return `/contract-logos/${local[base]}`;
  if(type==='TRADFI')return domains[base]?`https://www.google.com/s2/favicons?domain=${domains[base]}&sz=64`:'';
  return `https://assets.coincap.io/assets/icons/${base.toLowerCase()}@2x.png`;
}
