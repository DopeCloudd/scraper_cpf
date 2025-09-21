export const randomBetween = (min: number, max: number): number => {
  if (max <= min) return min;
  return Math.random() * (max - min) + min;
};

export const waitFor = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const humanDelay = async (baseMs = 1000): Promise<void> => {
  const jitter = randomBetween(0.3, 1.7);
  await waitFor(baseMs * jitter);
};
