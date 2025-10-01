import 'dotenv/config';

type BoolLike = boolean | 'true' | 'false' | '1' | '0' | undefined;

const toBool = (value: BoolLike, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
};

export const appConfig = {
  headless: toBool(process.env.PUPPETEER_HEADLESS as BoolLike, true),
  slowMo: Number(process.env.PUPPETEER_SLOWMO ?? 0),
  maxPagesPerQuery: Number(process.env.MAX_PAGES_PER_QUERY ?? 50),
  itemsPerPage: Number(process.env.ITEMS_PER_PAGE ?? 10),
  minWaitMs: Number(process.env.MIN_WAIT_MS ?? 750),
  maxWaitMs: Number(process.env.MAX_WAIT_MS ?? 2000),
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS ?? 45000),
  detailBatchSize: Number(process.env.DETAIL_BATCH_SIZE ?? 10),
  detailConcurrency: Number(process.env.DETAIL_CONCURRENCY ?? 2),
  detailMaxRetries: Number(process.env.DETAIL_MAX_RETRIES ?? 2),
  detailPageReuseLimit: Number(process.env.DETAIL_PAGE_REUSE_LIMIT ?? 25),
  detailIdleWaitMs: Number(process.env.DETAIL_IDLE_WAIT_MS ?? 250),
};
