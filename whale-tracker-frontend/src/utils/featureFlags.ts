// Temporarily hide the strategy workspace without removing its code or saved data.
export const STRATEGY_WORKSPACE_ENABLED = false;

// Enabled by default; set to 0 only for an explicit diagnostic pause.
export const RADAR_ENABLED = import.meta.env.VITE_RADAR_ENABLED !== '0';

// Re-enable alongside WHALE_OBSERVATIONS_ENABLED=1 on the backend.
export const WHALE_OBSERVATIONS_ENABLED = import.meta.env.VITE_WHALE_OBSERVATIONS_ENABLED === '1';
