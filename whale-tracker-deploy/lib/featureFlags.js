// Opt in explicitly; restart the backend after changing the environment.
const observationsEnabled=()=>process.env.WHALE_OBSERVATIONS_ENABLED==='1';
// Enabled by default; keep an explicit emergency pause available.
const radarEnabled=()=>process.env.RADAR_ENABLED!=='0';
module.exports={observationsEnabled,radarEnabled};
