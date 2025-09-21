import type { Browser, Page } from 'puppeteer';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { appConfig } from '../config/appConfig';
import { searchQueries, SearchQuery } from '../config/searchQueries';
import { createBrowser } from '../scraper/browser';
import { humanDelay, randomBetween } from '../utils/humanizer';
import { logger } from '../utils/logger';
import { randomUserAgent } from '../utils/userAgent';
import { normalizeCenterName, sanitizeCity, sanitizeCountry, sanitizePostalCode, sanitizeRegion } from '../utils/center';

const RESULTS_BASE_URL =
  'https://www.moncompteformation.gouv.fr/espace-prive/html/#/formation/recherche/resultats?q=';
const DETAIL_BASE_URL =
  'https://www.moncompteformation.gouv.fr/espace-prive/html/#/formation/fiche/';

const extractDetailPath = (link?: string | null): string | undefined => {
  if (!link) return undefined;
  let candidate = link;
  try {
    const url = new URL(link, 'https://www.moncompteformation.gouv.fr/');
    candidate = url.hash ? url.hash.slice(1) : url.pathname;
  } catch {
    // ignore relative URL parsing errors
  }

  candidate = candidate.replace(/^#/u, '').replace(/^\/+/, '');
  if (!candidate.startsWith('formation/')) return undefined;
  candidate = candidate.replace(/^formation\/(?:recherche|fiche)\//, '');
  candidate = candidate.split('?')[0];
  return candidate || undefined;
};

const buildDetailUrl = (pathValue?: string | null): string | undefined => {
  if (!pathValue) return undefined;
  const segments = String(pathValue)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  if (segments.length === 0) return undefined;
  return `${DETAIL_BASE_URL}${segments.join('/')}`;
};

type JsonRecord = Record<string, unknown>;

type NormalizedListItem = {
  trainingExternalId?: string;
  listPageData: Prisma.InputJsonValue;
  title?: string;
  detailUrl?: string;
  summary?: string;
  modality?: string;
  certification?: string;
  locationText?: string;
  region?: string;
  priceText?: string;
  priceValue?: number;
  durationText?: string;
  durationHours?: number;
  centerName?: string;
  centerExternalId?: string;
  centerCity?: string;
  centerPostalCode?: string;
  centerRegion?: string;
  centerCountry?: string;
};

type ExtractedPage = {
  items: JsonRecord[];
  totalResults?: number;
};

const buildSearchUrl = (payload: JsonRecord): string => {
  const json = JSON.stringify(payload);
  return `${RESULTS_BASE_URL}${encodeURIComponent(json)}`;
};

const identifyItemKey = (item: JsonRecord): string => {
  const possibleKeys = [
    'id',
    'idFormation',
    'idOffre',
    'numeroOffre',
    'numeroFormation',
    'code',
    'codeFormation',
    'detailUrl',
    'url',
    'urlFiche',
    'trainingCardId',
  ];

  for (const key of possibleKeys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }

  return JSON.stringify(item);
};

const extractItemsFromPayload = (payload: unknown): ExtractedPage => {
  if (!payload || typeof payload !== 'object') {
    return { items: [] };
  }

  if (Array.isArray(payload)) {
    return { items: payload as JsonRecord[] };
  }

  const candidates = [
    'resultats',
    'listeResultats',
    'results',
    'items',
    'formations',
    'hits',
  ];

  for (const key of candidates) {
    const value = (payload as JsonRecord)[key];
    if (Array.isArray(value)) {
      const totalKey = 'total' in payload ? (payload as JsonRecord)['total'] : undefined;
      return {
        items: value as JsonRecord[],
        totalResults: typeof totalKey === 'number' ? totalKey : undefined,
      };
    }
  }

  return { items: [] };
};

const pickString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
};

const pickNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const normalized = value.replace(/[^0-9.,-]/g, '').replace(',', '.');
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};

const normalizeListItem = (item: JsonRecord): NormalizedListItem => {
  const organisme = (item.organismeFormation ?? item.organisme ?? item.organismeFormateur) as
    | JsonRecord
    | undefined;
  const localisation = (item.lieuFormation ?? item.localisation) as JsonRecord | undefined;
  const rawDetailHref = pickString(
    item.detailUrl,
    item.detailHref,
    item.urlDetail,
    item.url,
    item.urlFiche,
    item.lienDetail
  );

  const trainingId = pickString(
    item.id,
    item.idFormation,
    item.numeroOffre,
    item.numeroFormation,
    item.code,
    item.codeFormation,
    item.numeroAction,
    item.trainingCardId
  );

  const detailPath = pickString(
    extractDetailPath(rawDetailHref),
    item.trainingCardId,
    trainingId
  );

  const detailUrl = buildDetailUrl(detailPath) ?? rawDetailHref;

  const priceValue = pickNumber(item.prix, item.prixMinimum, item.prixMin, item.cout, item.prixTexte, item.priceText);
  const durationHours = pickNumber(item.dureeHeures, item.duree, item.dureeTotale, item.durationText);

  const centerName = pickString(
    organisme?.libelle,
    organisme?.nom,
    organisme?.raisonSociale,
    item.nomOrganisme,
    item.organisme,
    item.centerName
  );

  return {
    trainingExternalId: pickString(
      item.idOffre,
      item.idFormation,
      item.numeroOffre,
      item.codeFormation,
      item.numeroAction,
      item.trainingCardId
    ),
    title: pickString(item.libelleFormation, item.libelle, item.titre, item.title),
    detailUrl,
    summary: pickString(item.resume, item.descriptionCourte, item.description, item.summary),
    modality: pickString(item.modalite, item.modality, item.modalites, item.modaliteLibelle),
    certification: pickString(item.certification, item.certificationLibelle),
    locationText: pickString(
      localisation?.libelle,
      localisation?.ville,
      item.localisation,
      item.ville,
      item.adresse,
      item.locationText
    ),
    region: pickString(localisation?.region, item.region),
    priceText: pickString(item.prixTexte, item.prixAffiche, item.coutAffiche, item.priceText),
    priceValue,
    durationText: pickString(item.dureeTexte, item.duree, item.dureeAffiche, item.durationText),
    durationHours: durationHours ? Math.round(durationHours) : undefined,
    listPageData: item as Prisma.InputJsonValue,
    centerName,
    centerExternalId: pickString(
      organisme?.id,
      organisme?.siret,
      organisme?.numeroDeclarationActivite
    ),
    centerCity: pickString(localisation?.ville, organisme?.ville),
    centerPostalCode: pickString(localisation?.codePostal, organisme?.codePostal),
    centerRegion: pickString(localisation?.region, organisme?.region),
    centerCountry: pickString(localisation?.pays, organisme?.pays, 'FR'),
  };
};

const collectPageData = async (page: Page, url: string): Promise<ExtractedPage> => {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: appConfig.navigationTimeoutMs,
    });
  } catch (error) {
    logger.warn('Échec navigation vers %s : %s', url, (error as Error).message);
  }

  try {
    await page.waitForSelector('#result-list-container mcf-dsfr-formation-carte', {
      timeout: appConfig.navigationTimeoutMs,
    });
  } catch (error) {
    logger.warn("Aucun résultat trouvé pour l'URL %s : %s", url, (error as Error).message);
  }

  await page.waitForTimeout(Math.ceil(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs)));

  const items = (await page.evaluate(() => {
    const cleanText = (value: string | null | undefined) => {
      if (!value) return undefined;
      const normalized = value.replace(/ | /g, ' ').replace(/\s+/g, ' ').trim();
      return normalized.length > 0 ? normalized : undefined;
    };

    const getIconText = (card: Element, iconClass: string) => {
      const icon = card.querySelector(`.${iconClass}`);
      if (!icon) return undefined;
      const listItem = icon.closest('li');
      if (!listItem) return undefined;

      const parts = Array.from(listItem.childNodes)
        .map((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent ?? '';
          }

          if (node instanceof HTMLElement) {
            if (node.classList.contains(iconClass) || node.classList.contains('fr-sr-only')) {
              return '';
            }
            return node.textContent ?? '';
          }

          return '';
        })
        .filter((snippet) => snippet && snippet.trim().length > 0);

      return cleanText(parts.join(' '));
    };

    const container = document.querySelector('#result-list-container');
    if (!container) return [] as Array<Record<string, unknown>>;

    const cards = Array.from(container.querySelectorAll('mcf-dsfr-formation-carte'));
    return cards.map((card) => {
      const titleLink = card.querySelector('h3 a');
      const centerLine = card.querySelector('.form-carte__sous-titre');
      const summary = card.querySelector('.form-carte__certification p');
      const absoluteHref = (titleLink as HTMLAnchorElement | null)?.href ?? undefined;
      const rawHref = titleLink?.getAttribute('href') ?? undefined;
      const rawId = (card as HTMLElement | null)?.id || undefined;

      const priceText = getIconText(card, 'fr-icon-money-euro-circle-line');
      const durationText = getIconText(card, 'fr-icon-time-line');
      const locationText = getIconText(card, 'fr-icon-map-pin-2-line');

      const centerNameRaw = cleanText(centerLine?.textContent ?? undefined);
      const centerName = centerNameRaw?.replace(/^Proposée par\s*/i, '').trim() || centerNameRaw;

      return {
        title: cleanText(titleLink?.textContent ?? undefined),
        detailUrl: absoluteHref,
        detailHref: rawHref,
        trainingCardId: rawId,
        summary: cleanText(summary?.textContent ?? undefined),
        centerName,
        priceText,
        durationText,
        locationText,
        outerHTML: (card as HTMLElement).outerHTML,
      };
    });
  })) as JsonRecord[];

  return { items, totalResults: items.length };
};

const ensureCenter = async (item: NormalizedListItem) => {
  const name = item.centerName?.trim();
  if (!name) return null;

  const normalizedName = normalizeCenterName(name);
  if (!normalizedName) {
    logger.warn('Nom de centre impossible à normaliser: %s', name);
    return null;
  }

  const now = new Date();
  const city = sanitizeCity(item.centerCity);
  const postalCode = sanitizePostalCode(item.centerPostalCode);
  const region = sanitizeRegion(item.centerRegion);
  const country = sanitizeCountry(item.centerCountry) ?? 'FR';

  const createData: Prisma.TrainingCenterCreateInput = {
    name,
    normalizedName,
    country,
    lastListScrapedAt: now,
    ...(city ? { city } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(region ? { region } : {}),
  };

  const updateData: Prisma.TrainingCenterUpdateInput = {
    name,
    normalizedName,
    lastListScrapedAt: now,
  };

  if (city) updateData.city = city;
  if (postalCode) updateData.postalCode = postalCode;
  if (region) updateData.region = region;
  if (country) updateData.country = country;

  if (item.centerExternalId) {
    return prisma.trainingCenter.upsert({
      where: { externalId: item.centerExternalId },
      update: updateData,
      create: {
        ...createData,
        externalId: item.centerExternalId,
      },
    });
  }

  const existing = await prisma.trainingCenter.findFirst({
    where: { normalizedName },
  });

  if (existing) {
    return prisma.trainingCenter.update({
      where: { id: existing.id },
      data: updateData,
    });
  }

  return prisma.trainingCenter.create({
    data: createData,
  });
};

const persistListItem = async (normalized: NormalizedListItem, query: SearchQuery) => {
  if (!normalized.title || !normalized.detailUrl) {
    logger.warn('Item ignoré (title/detailUrl manquant): %o', normalized.listPageData);
    return;
  }

  const center = await ensureCenter(normalized);
  if (!center) {
    logger.warn('Centre non déterminé pour %s', normalized.title);
    return;
  }

  const now = new Date();
  const priceDecimal =
    typeof normalized.priceValue === 'number'
      ? new Prisma.Decimal(normalized.priceValue.toFixed(2))
      : undefined;

  await prisma.training.upsert({
    where: { detailUrl: normalized.detailUrl },
    update: {
      centerId: center.id,
      externalId: normalized.trainingExternalId ?? undefined,
      title: normalized.title,
      summary: normalized.summary,
      modality: normalized.modality,
      certification: normalized.certification,
      locationText: normalized.locationText,
      region: normalized.region,
      priceText: normalized.priceText,
      priceValue: priceDecimal,
      durationText: normalized.durationText,
      durationHours: normalized.durationHours ?? undefined,
      searchQuery: query.name,
      needsDetail: true,
      listPageData: normalized.listPageData as Prisma.InputJsonValue,
      lastListScrapedAt: now,
    },
    create: {
      centerId: center.id,
      externalId: normalized.trainingExternalId ?? undefined,
      title: normalized.title,
      detailUrl: normalized.detailUrl,
      summary: normalized.summary,
      modality: normalized.modality,
      certification: normalized.certification,
      locationText: normalized.locationText,
      region: normalized.region,
      priceText: normalized.priceText,
      priceValue: priceDecimal,
      durationText: normalized.durationText,
      durationHours: normalized.durationHours ?? undefined,
      searchQuery: query.name,
      needsDetail: true,
      listPageData: normalized.listPageData as Prisma.InputJsonValue,
      lastListScrapedAt: now,
    },
  });
};

const processQuery = async (browser: Browser, query: SearchQuery) => {
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(appConfig.navigationTimeoutMs);
  await page.setUserAgent(randomUserAgent());
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    if (['image', 'media', 'font'].includes(resourceType)) {
      request.abort().catch(() => undefined);
      return;
    }

    request.continue().catch(() => undefined);
  });

  const basePayload = JSON.parse(JSON.stringify(query.payload)) as JsonRecord;
  const perPage =
    typeof basePayload.nombreOccurences === 'number'
      ? basePayload.nombreOccurences
      : appConfig.itemsPerPage;

  const processedKeys = new Set<string>();
  let pageIndex = 0;
  let totalSaved = 0;

  try {
    while (pageIndex < appConfig.maxPagesPerQuery) {
      const offset = pageIndex * perPage;
      const payload = {
        ...basePayload,
        debutPagination: offset + 1,
        nombreOccurences: perPage,
      };

      const url = buildSearchUrl(payload);
      logger.info('Extraction liste %s — page %d via %s', query.name, pageIndex + 1, url);
      const { items } = await collectPageData(page, url);

      if (items.length === 0) {
        logger.info('Aucun résultat supplémentaire pour %s après %d pages', query.name, pageIndex + 1);
        break;
      }

      for (const raw of items) {
        const key = identifyItemKey(raw);
        if (processedKeys.has(key)) {
          continue;
        }
        processedKeys.add(key);

        const normalized = normalizeListItem(raw);
        normalized.listPageData = raw as Prisma.InputJsonValue;

        try {
          await persistListItem(normalized, query);
          totalSaved += 1;
        } catch (error) {
          logger.error('Échec sauvegarde formation: %s', (error as Error).message, {
            detailUrl: normalized.detailUrl,
          });
        }
      }

      pageIndex += 1;

      if (items.length < perPage) {
        logger.info('Dernière page atteinte pour %s', query.name);
        break;
      }

      await humanDelay(randomBetween(appConfig.minWaitMs, appConfig.maxWaitMs));
    }

    logger.info('Extraction terminée pour %s avec %d éléments', query.name, totalSaved);
  } finally {
    page.removeAllListeners('request');
    await page.close();
  }
};

export const runExtraction = async (queries: SearchQuery[] = searchQueries) => {
  const browser = await createBrowser();

  try {
    for (const query of queries) {
      await processQuery(browser, query);
      await humanDelay(randomBetween(1500, 4000));
    }
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
};
