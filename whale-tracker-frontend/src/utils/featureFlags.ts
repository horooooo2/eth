// Temporarily hide the strategy workspace without removing its code or saved data.
export const STRATEGY_WORKSPACE_ENABLED = false;

// Re-enable alongside WHALE_OBSERVATIONS_ENABLED=1 on the backend.
export const WHALE_OBSERVATIONS_ENABLED = import.meta.env.VITE_WHALE_OBSERVATIONS_ENABLED === '1';
