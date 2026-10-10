// Render layers used to hide geometry from specific cameras.
export const LAYER = {
  WORLD: 0,
  COCKPIT: 1, // interior: hidden from the rear-view mirror camera
  DRIVER_BODY: 2, // driver's head/torso: hidden from the driver's own camera
  NAV_BODY: 3, // navigator's head/torso: hidden from the navigator's camera
} as const;
