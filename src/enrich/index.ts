import type { Page } from 'puppeteer';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { createBrowser } from '../scraper/browser';
import { appConfig } from '../config/appConfig';
import { humanDelay, randomBetween } from '../utils/humanizer';
import { logger } from '../utils/logger';
import { randomUserAgent } from '../utils/userAgent';

const DETAIL_BASE_URL =
  'https://www.moncompteformation.gouv.fr/espace-prive/html/#/formation/fiche/';

interface ContactsInfo {
  email?: string;
  phone?: string;
  website?: string;
}

interface ParsedDetailData {
  priceText?: string;
  priceValue?: number;
  durationText?: string;
  durationHours?: number;
  contacts: ContactsInfo;
  address?: string;
  city?: string;
  postalCode?: string;
  region?: string;
  country?: string;
  summary?: string;
  raw: Prisma.InputJsonValue;
}

const selectTrainingFields = {
  id: true,
  detailUrl: true,
  title: true,
  needsDetail: true,
  listPageData: true,
  centerId: true,
  detailPageData: true,
  lastDetailScrapedAt: true,
} satisfies Record<string, boolean>;

const extractContacts = async (page: Page): Promise<ContactsInfo> => {
  const contacts = await page.$$eval('a[href^="mailto:"], a[href^="tel:"], a[href^="http"]', (anchors) => {
    const info: ContactsInfo = {};

    for (const anchor of anchors) {
      const href = (anchor as HTMLAnchorElement).href;
      if (!href) continue;
      if (href.startsWith('mailto:') && !info.email) {
        info.email = href.replace('mailto:', '').trim();
        continue;
      }
      if (href.startsWith('tel:') && !info.phone) {
        info.phone = href.replace('tel:', '').trim();
        continue;
      }
      if (!info.website && href.startsWith('http')) {
        const url = new URL(href);
        if (!['moncompteformation.gouv.fr'].includes(url.hostname)) {
          info.website = href;
        }
      }
    }

    return info;
  });

  return contacts ?? {};
};

const pickText = async (page: Page, selectors: string[]): Promise<string | undefined> => {
  for (const selector of selectors) {
    const text = await page.$eval(selector, (element) => element.textContent?.trim() || undefined).catch(() => undefined);
    if (text) return text;
  }
  return undefined;
};

const toNumber = (value?: string | null): number | undefined => {
  if (!value) return undefined;
  const normalized = value.replace(/[^0-9.,-]/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseDetailPage = async (page: Page): Promise<ParsedDetailData> => {
  const [priceText, durationText, addressBlock, summary] = await Promise.all([
    pickText(page, [
      '[data-test="price"]',
      '.formation__price',
      '.resume__price',
      '.info-prix',
    ]),
    pickText(page, [
      '[data-test="duration"]',
      '.formation__duration',
      '.resume__duration',
      '.info-duree',
    ]),
    pickText(page, [
      '[data-test="organisme-adresse"]',
      '.organisme__address',
      '.formation__adresse',
      '.organisme-block .adresse',
    ]),
    pickText(page, [
      '[data-test="resume"]',
      '.resume__description',
      '.formation__description',
      '.bloc-description',
    ]),
  ]);

  const contacts = await extractContacts(page);

  const detailJson = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const globals: Record<string, any> = {};
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]'));
    const datasets = scripts.map((script) => script.textContent).filter(Boolean);
    if (datasets.length > 0) {
      return datasets;
    }

    globals.dataset = (window as unknown as Record<string, unknown>).dataset;
    return globals;
  });

  const priceValue = toNumber(priceText ?? contacts.email ?? undefined);
  const durationValue = toNumber(durationText);

  let city: string | undefined;
  let postalCode: string | undefined;
  let region: string | undefined;
  let country: string | undefined;

  if (addressBlock) {
    const parts = addressBlock.split(/\n|,/).map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      const postalMatch = part.match(/(\d{5})/);
      if (postalMatch) {
        postalCode = postalMatch[1];
        const index = part.indexOf(postalMatch[1]);
        if (index >= 0) {
          city = part.slice(index + postalMatch[1].length).trim();
        }
        continue;
      }

      if (/France/i.test(part)) {
        country = 'FR';
        continue;
      }

      if (!city && /[A-Za-zÀ-ÿ\s-]+/.test(part)) {
        city = part.trim();
      }

      if (!region && /Région|Region|Île-de-France/i.test(part)) {
        region = part.trim();
      }
    }
  }

  return {
    priceText,
    priceValue,
    durationText,
    durationHours: durationValue ? Math.round(durationValue) : undefined,
    contacts,
    address: addressBlock,
    city,
    postalCode,
    region,
    country,
    summary,
    raw: detailJson as Prisma.InputJsonValue,
  };
};

const updateCenterInfo = async (centerId: number, parsed: ParsedDetailData) => {
  const centerUpdates: Prisma.TrainingCenterUpdateArgs['data'] = {
    lastDetailScrapedAt: new Date(),
  };

  if (parsed.address) centerUpdates.address = parsed.address;
  if (parsed.city) centerUpdates.city = parsed.city;
  if (parsed.postalCode) centerUpdates.postalCode = parsed.postalCode;
  if (parsed.region) centerUpdates.region = parsed.region;
  if (parsed.country) centerUpdates.country = parsed.country;
  if (parsed.contacts.email) centerUpdates.email = parsed.contacts.email;
  if (parsed.contacts.phone) centerUpdates.phone = parsed.contacts.phone;
  if (parsed.contacts.website) centerUpdates.website = parsed.contacts.website;

  await prisma.trainingCenter.update({
    where: { id: centerId },
    data: centerUpdates,
  });
};

const processTraining = async (page: Page, trainingId: number): Promise<boolean> => {
  const training = await prisma.training.findUnique({
    where: { id: trainingId },
    select: selectTrainingFields,
  });

  if (!training) {
    logger.warn('Formation %d introuvable', trainingId);
    return false;
  }

  if (!training.detailUrl) {
    logger.warn('Formation %d sans URL détail', trainingId);
    await prisma.training.update({
      where: { id: trainingId },
      data: { needsDetail: false },
    });
    return false;
  }

  const detailUrl = training.detailUrl.startsWith('http')
    ? training.detailUrl
    : `${DETAIL_BASE_URL}${training.detailUrl}`;

  let parseResult: ParsedDetailData | undefined;

  try {
    await page.setUserAgent(randomUserAgent());
    await page.goto(detailUrl, {
      waitUntil: 'networkidle2',
      timeout: appConfig.navigationTimeoutMs,
    });

    await page.waitForTimeout(Math.ceil(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs)));

    parseResult = await parseDetailPage(page);
  } catch (error) {
    logger.error('Erreur chargement fiche %d (%s): %s', trainingId, detailUrl, (error as Error).message);
    return false;
  }

  if (!parseResult) {
    logger.warn('Parse détail vide pour formation %d', trainingId);
    return false;
  }

  await prisma.$transaction(async (tx) => {
    const priceDecimal =
      typeof parseResult?.priceValue === 'number'
        ? new Prisma.Decimal(parseResult.priceValue.toFixed(2))
        : undefined;

    await tx.training.update({
      where: { id: trainingId },
      data: {
        priceText: parseResult?.priceText ?? undefined,
        priceValue: priceDecimal,
        durationText: parseResult?.durationText ?? undefined,
        durationHours: parseResult?.durationHours ?? undefined,
        summary: parseResult?.summary ?? undefined,
        detailPageData: parseResult?.raw,
        needsDetail: false,
        lastDetailScrapedAt: new Date(),
      },
    });

    if (parseResult) {
      await updateCenterInfo(training.centerId, parseResult);
    }
  });

  return true;
};

export const runEnrichment = async () => {
  const browser = await createBrowser();
  const page = await browser.newPage();

  await page.setDefaultNavigationTimeout(appConfig.navigationTimeoutMs);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  let processed = 0;
  let success = 0;

  try {
    while (processed < appConfig.detailBatchSize) {
      const training = await prisma.training.findFirst({
        where: { needsDetail: true },
        select: { id: true },
        orderBy: [{ lastDetailScrapedAt: 'asc' }, { id: 'asc' }],
      });

      if (!training) {
        logger.info('Aucune formation à enrichir.');
        break;
      }

      const result = await processTraining(page, training.id);
      processed += 1;
      if (result) {
        success += 1;
        await humanDelay(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs));
      } else {
        await prisma.training.update({
          where: { id: training.id },
          data: {
            lastDetailScrapedAt: new Date(),
          },
        });
        await humanDelay(randomBetween(2000, 5000));
      }
    }

    logger.info('Enrichissement terminé: %d traité(s), %d succès', processed, success);
  } finally {
    await page.close();
    await browser.close();
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  runEnrichment().catch((error) => {
    logger.error('Enrichissement échoué: %s', (error as Error).message);
    process.exitCode = 1;
    void prisma.$disconnect();
  });
}
