// Opt in explicitly; restart the backend after changing the environment.
const observationsEnabled=()=>process.env.WHALE_OBSERVATIONS_ENABLED==='1';
module.exports={observationsEnabled};
