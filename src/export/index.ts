/* eslint-disable no-console */
import ExcelJS from "exceljs";
import fs from "fs/promises";
import path from "path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { logger } from "../utils/logger"; // si vous n'avez pas ce logger, remplacez par console

// ------------------------- Config export -------------------------
const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const PAGE_SIZE = Number(process.env.EXPORT_PAGE_SIZE ?? 1000); // pagination DB
const MAX_FILE_SIZE_BYTES = (() => {
  const raw = Number(process.env.EXPORT_MAX_FILE_SIZE_BYTES ?? 1024 * 1024);
  return Number.isFinite(raw) && raw > 0 ? raw : 1024 * 1024;
})();
const DEFAULT_CENTER_CHUNK_SIZE = (() => {
  const raw = Number(process.env.EXPORT_CENTERS_PER_CHUNK ?? 500);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
})();

// Formats Excel
const DATE_FMT = "yyyy-mm-dd hh:mm";
const MONEY_FMT = "#,##0.00";

// Helpers
const toNumberSafe = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  // Prisma.Decimal
  if (typeof (v as any)?.toNumber === "function") {
    try {
      return (v as any).toNumber();
    } catch {
      return undefined;
    }
  }
  if (typeof v === "string" && v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const ensureDir = async (dir: string) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
};

const isNonEmptyString = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

type CenterContactInfo = {
  siren: string | null;
  siret: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
};

const isCenterClean = (center: CenterContactInfo): boolean =>
  isNonEmptyString(center.siren) &&
  isNonEmptyString(center.siret) &&
  isNonEmptyString(center.city) &&
  isNonEmptyString(center.email) &&
  (isNonEmptyString(center.phone) || isNonEmptyString(center.website));

const buildCleanCenterWhere = (): Prisma.TrainingCenterWhereInput => ({
  AND: [
    { siren: { not: null } },
    { siren: { not: "" } },
    { siret: { not: null } },
    { siret: { not: "" } },
    { city: { not: null } },
    { city: { not: "" } },
    { email: { not: null } },
    { email: { not: "" } },
    {
      OR: [
        {
          AND: [{ phone: { not: null } }, { phone: { not: "" } }],
        },
        {
          AND: [{ website: { not: null } }, { website: { not: "" } }],
        },
      ],
    },
  ],
});

const combineCenterWhere = (
  clauses: Array<Prisma.TrainingCenterWhereInput | undefined>
): Prisma.TrainingCenterWhereInput | undefined => {
  const filtered = clauses.filter(
    (clause): clause is Prisma.TrainingCenterWhereInput => clause != null
  );
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];
  return { AND: filtered };
};

const combineTrainingWhere = (
  clauses: Array<Prisma.TrainingWhereInput | undefined>
): Prisma.TrainingWhereInput | undefined => {
  const filtered = clauses.filter(
    (clause): clause is Prisma.TrainingWhereInput => clause != null
  );
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];
  return { AND: filtered };
};

type TitleFilter = {
  raw: string;
  normalized: string;
};

type TitleFilterMatches = {
  filter: TitleFilter;
  trainingIds: number[];
  centerIds: number[];
};

const normalizeMatchText = (value: string | null | undefined): string => {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
};

const buildTitleFilter = (raw: string | undefined): TitleFilter | undefined => {
  if (!raw) return undefined;
  const normalized = normalizeMatchText(raw);
  if (!normalized) return undefined;
  return { raw, normalized };
};

const titleMatchesFilter = (
  title: string | null | undefined,
  filter?: TitleFilter
): boolean => {
  if (!filter) return true;
  const normalizedTitle = normalizeMatchText(title);
  if (!normalizedTitle) return false;
  return normalizedTitle.includes(filter.normalized);
};

const chunkArray = <T>(values: T[], chunkSize: number): T[][] => {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
};

const sanitizeForFilename = (value: string): string => {
  const normalized = value
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || "export";
};

const formatBytes = (value: number): string => {
  if (!Number.isFinite(value)) return `${value}`;
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} Ko`;
  return `${(value / (1024 * 1024)).toFixed(2)} Mo`;
};

const safeUnlink = async (targetPath: string): Promise<void> => {
  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

const createTempFilePath = (baseName: string): string =>
  path.join(
    EXPORT_DIR,
    `${baseName}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp.xlsx`
  );

const collectTitleFilterMatches = async (
  filter: TitleFilter,
  options: Pick<ExportOptions, "createdAfter" | "cleanOnly">
): Promise<TitleFilterMatches> => {
  const trainingIds = new Set<number>();
  const centerIds = new Set<number>();

  let lastId: number | undefined;

  for (;;) {
    const where = combineTrainingWhere([
      options.createdAfter
        ? { createdAt: { gte: options.createdAfter } }
        : undefined,
      options.cleanOnly
        ? { center: { is: buildCleanCenterWhere() } }
        : undefined,
      lastId ? { id: { gt: lastId } } : undefined,
    ]);

    const trainings = await prisma.training.findMany({
      where,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true, centerId: true, title: true },
    });

    if (trainings.length === 0) break;

    for (const t of trainings) {
      if (titleMatchesFilter(t.title, filter)) {
        trainingIds.add(t.id);
        centerIds.add(t.centerId);
      }
    }

    lastId = trainings[trainings.length - 1].id;
    if (trainings.length < PAGE_SIZE) break;
  }

  return {
    filter,
    trainingIds: Array.from(trainingIds).sort((a, b) => a - b),
    centerIds: Array.from(centerIds).sort((a, b) => a - b),
  };
};

type CtrLite = {
  id: number;
  name: string;
  city: string | null;
  postalCode: string | null;
  region: string | null;
  country: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
};

type SheetOptions = {
  createdAfter?: Date;
  cleanOnly?: boolean;
  titleFilterMatches?: TitleFilterMatches;
  centerIdFilter?: number[];
  trainingIdsFilter?: number[];
};

// ------------------------- Sheets builders -------------------------

async function writeCentersSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: SheetOptions = {}
) {
  const ws = workbook.addWorksheet("Centres", {
    properties: { tabColor: { argb: "FF1F497D" } },
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const columns: Array<Partial<ExcelJS.Column>> = [
    { header: "ID", key: "id", width: 8 },
    { header: "Nom", key: "name", width: 40 },
    { header: "Ville", key: "city", width: 18 },
    { header: "CP", key: "postalCode", width: 10 },
    { header: "Région", key: "region", width: 18 },
    { header: "Pays", key: "country", width: 8 },
    { header: "SIREN", key: "siren", width: 16 },
    { header: "SIRET", key: "siret", width: 22 },
    { header: "Email", key: "email", width: 28 },
    { header: "Téléphone", key: "phone", width: 16 },
    { header: "Site", key: "website", width: 40 },
    { header: "Nb stagiaires déclarés", key: "declTrainees", width: 14 },
    { header: "Nb stagiaires délégués", key: "delegTrainees", width: 14 },
    { header: "Nb formateurs", key: "declTrainers", width: 14 },
    { header: "Début exercice", key: "fiscalYearStart", width: 18 },
    { header: "MAJ OpenData", key: "openDataUpdatedAt", width: 20 },
    { header: "Formations (nb)", key: "trainingsCount", width: 16 },
    { header: "List scrappée", key: "lastListScrapedAt", width: 20 },
    { header: "Detail scrappé", key: "lastDetailScrapedAt", width: 20 },
    { header: "Créé", key: "createdAt", width: 20 },
    { header: "MAJ", key: "updatedAt", width: 20 },
    { header: "Terme recherché", key: "titleFilter", width: 24 },
  ];
  ws.columns = columns;
  ws.addRow(columns.map((c) => c.header)).font = { bold: true };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  const matchedCenterIds = options.titleFilterMatches?.centerIds;
  const matchedTrainingIds = options.titleFilterMatches?.trainingIds;
  const chunkCenterIds = options.centerIdFilter;
  const chunkCenterSet = chunkCenterIds
    ? new Set(chunkCenterIds)
    : undefined;
  const effectiveMatchedCenterIds = matchedCenterIds
    ? chunkCenterSet
      ? matchedCenterIds.filter((id) => chunkCenterSet.has(id))
      : matchedCenterIds
    : undefined;

  if (chunkCenterIds && chunkCenterIds.length === 0) {
    logger.info?.("Centres: chunk vide, aucune ligne à écrire");
    ws.commit();
    return;
  }

  if (effectiveMatchedCenterIds && effectiveMatchedCenterIds.length === 0) {
    logger.info?.("Centres: aucun centre pour le filtre de titre fourni");
    ws.commit();
    return;
  }

  // Precompute counts per center
  const trainingCountWhere: Prisma.TrainingWhereInput | undefined =
    combineTrainingWhere([
      options.createdAfter
        ? { createdAt: { gte: options.createdAfter } }
        : undefined,
      options.cleanOnly
        ? { center: { is: buildCleanCenterWhere() } }
        : undefined,
      matchedTrainingIds ? { id: { in: matchedTrainingIds } } : undefined,
      chunkCenterIds ? { centerId: { in: chunkCenterIds } } : undefined,
      options.trainingIdsFilter
        ? { id: { in: options.trainingIdsFilter } }
        : undefined,
    ]);
  const counts = await prisma.training.groupBy({
    by: ["centerId"],
    _count: { _all: true },
    ...(trainingCountWhere ? { where: trainingCountWhere } : {}),
  });
  const countMap = new Map<number, number>();
  counts.forEach((c) => countMap.set(c.centerId, c._count._all));

  let page = 0;
  let total = 0;

  type CenterRow = {
    id: number;
    name: string;
    city: string | null;
    postalCode: string | null;
    region: string | null;
    country: string | null;
    siren: string | null;
    siret: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    declaredTrainees: number | null;
    delegatedTrainees: number | null;
    declaredTrainers: number | null;
    fiscalYearStart: Date | null;
    openDataUpdatedAt: Date | null;
    lastListScrapedAt: Date | null;
    lastDetailScrapedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  const writeCentersBatch = (centers: CenterRow[]) => {
    for (const c of centers) {
      if (options.cleanOnly && !isCenterClean(c)) {
        continue;
      }
      const row = ws.addRow({
        id: c.id,
        name: c.name,
        city: c.city ?? "",
        postalCode: c.postalCode ?? "",
        region: c.region ?? "",
        country: c.country ?? "",
        siren: c.siren ?? "",
        siret: c.siret ?? "",
        email: c.email ?? "",
        phone: c.phone ?? "",
        website: c.website ?? "",
        declTrainees: c.declaredTrainees ?? "",
        delegTrainees: c.delegatedTrainees ?? "",
        declTrainers: c.declaredTrainers ?? "",
        fiscalYearStart: c.fiscalYearStart ?? "",
        openDataUpdatedAt: c.openDataUpdatedAt ?? "",
        trainingsCount: countMap.get(c.id) ?? 0,
        lastListScrapedAt: c.lastListScrapedAt ?? "",
        lastDetailScrapedAt: c.lastDetailScrapedAt ?? "",
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        titleFilter: options.titleFilterMatches?.filter.raw ?? "",
      });

      const colIdx = (key: string) =>
        columns.findIndex((c) => c.key === key) + 1;

      if (c.website) {
        row.getCell(colIdx("website")).value = {
          text: c.website,
          hyperlink: /^https?:\/\//i.test(c.website)
            ? c.website
            : `https://${c.website}`,
        } as ExcelJS.CellHyperlinkValue;
      }

      [
        "openDataUpdatedAt",
        "fiscalYearStart",
        "lastListScrapedAt",
        "lastDetailScrapedAt",
        "createdAt",
        "updatedAt",
      ].forEach((k) => {
        const cell = row.getCell(colIdx(k));
        if (cell.value) cell.numFmt = DATE_FMT;
      });

      row.commit();
      total++;
    }
  };

  // Stream centers by pages
  if (effectiveMatchedCenterIds) {
    const batches = chunkArray(effectiveMatchedCenterIds, PAGE_SIZE);
    for (const batch of batches) {
      const centers = await prisma.trainingCenter.findMany({
        where: combineCenterWhere([
          options.cleanOnly ? buildCleanCenterWhere() : undefined,
          options.createdAfter
            ? { createdAt: { gte: options.createdAfter } }
            : undefined,
          { id: { in: batch } },
        ]),
        orderBy: { id: "asc" },
        select: {
          id: true,
          name: true,
          city: true,
          postalCode: true,
          region: true,
          country: true,
          siren: true,
          siret: true,
          email: true,
          phone: true,
          website: true,
          declaredTrainees: true,
          delegatedTrainees: true,
          declaredTrainers: true,
          fiscalYearStart: true,
          openDataUpdatedAt: true,
          lastListScrapedAt: true,
          lastDetailScrapedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (centers.length === 0) continue;
      page += 1;
      writeCentersBatch(centers);
      logger.info?.(`Centres filtrés: page ${page}, cumul ${total}`);
    }
  } else {
    let lastId: number | undefined;
    for (;;) {
      const where = combineCenterWhere([
        options.cleanOnly ? buildCleanCenterWhere() : undefined,
        options.createdAfter
          ? { createdAt: { gte: options.createdAfter } }
          : undefined,
        lastId ? { id: { gt: lastId } } : undefined,
        options.centerIdFilter
          ? { id: { in: options.centerIdFilter } }
          : undefined,
      ]);

      const centers = await prisma.trainingCenter.findMany({
        where,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        select: {
          id: true,
          name: true,
          city: true,
          postalCode: true,
          region: true,
          country: true,
          siren: true,
          siret: true,
          email: true,
          phone: true,
          website: true,
          declaredTrainees: true,
          delegatedTrainees: true,
          declaredTrainers: true,
          fiscalYearStart: true,
          openDataUpdatedAt: true,
          lastListScrapedAt: true,
          lastDetailScrapedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (centers.length === 0) break;
      page += 1;
      writeCentersBatch(centers);

      lastId = centers[centers.length - 1].id;
      logger.info?.(`Centres: page ${page}, cumul ${total}`);
      if (centers.length < PAGE_SIZE) break;
    }
  }

  ws.commit();
}

async function writeTrainingsSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: SheetOptions = {}
) {
  const ws = workbook.addWorksheet("Formations", {
    properties: { tabColor: { argb: "FF8064A2" } },
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const columns: Array<Partial<ExcelJS.Column>> = [
    { header: "ID", key: "id", width: 8 },
    { header: "Centre ID", key: "centerId", width: 10 },
    { header: "Centre", key: "centerName", width: 40 },
    { header: "Ville (centre)", key: "centerCity", width: 18 },
    { header: "Titre formation", key: "title", width: 50 },
    { header: "Modalité", key: "modality", width: 18 },
    { header: "Certification", key: "certification", width: 22 },
    { header: "Localisation (fiche)", key: "locationText", width: 28 },
    { header: "Région (fiche)", key: "region", width: 18 },
    { header: "Prix (texte)", key: "priceText", width: 16 },
    { header: "Prix (num.)", key: "priceValue", width: 14 },
    { header: "Durée (texte)", key: "durationText", width: 16 },
    { header: "Durée (h)", key: "durationHours", width: 12 },
    { header: "Débute le", key: "startDate", width: 18 },
    { header: "Se termine le", key: "endDate", width: 18 },
    { header: "Recherche", key: "searchQuery", width: 18 },
    { header: "URL détail", key: "detailUrl", width: 60 },
    { header: "List scrappée", key: "lastListScrapedAt", width: 20 },
    { header: "Detail scrappé", key: "lastDetailScrapedAt", width: 20 },
    { header: "Créé", key: "createdAt", width: 20 },
    { header: "MAJ", key: "updatedAt", width: 20 },
    { header: "Terme recherché", key: "titleFilter", width: 24 },
  ];
  ws.columns = columns;
  ws.addRow(columns.map((c) => c.header)).font = { bold: true };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  const matchedTrainingIds = options.titleFilterMatches?.trainingIds;
  const chunkTrainingIds = options.trainingIdsFilter;
  const chunkTrainingSet = chunkTrainingIds
    ? new Set(chunkTrainingIds)
    : undefined;
  const chunkCenterIds = options.centerIdFilter;
  const effectiveMatchedTrainingIds = matchedTrainingIds
    ? chunkTrainingSet
      ? matchedTrainingIds.filter((id) => chunkTrainingSet.has(id))
      : matchedTrainingIds
    : undefined;

  if (
    (effectiveMatchedTrainingIds &&
      effectiveMatchedTrainingIds.length === 0) ||
    (chunkTrainingIds &&
      chunkTrainingIds.length === 0 &&
      !effectiveMatchedTrainingIds)
  ) {
    logger.info?.("Formations: chunk vide, aucune ligne à écrire");
    ws.commit();
    return;
  }

  let lastId: number | undefined;
  let page = 0;
  let total = 0;

  type TrainingRow = {
    id: number;
    centerId: number;
    title: string;
    detailUrl: string | null;
    summary: string | null;
    modality: string | null;
    certification: string | null;
    locationText: string | null;
    region: string | null;
    priceText: string | null;
    priceValue: Prisma.Decimal | number | string | null;
    durationText: string | null;
    durationHours: number | null;
    startDate: Date | null;
    endDate: Date | null;
    searchQuery: string | null;
    lastListScrapedAt: Date | null;
    lastDetailScrapedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  const writeTrainingsBatch = async (trainings: TrainingRow[]) => {
    if (trainings.length === 0) return;

    const centerIds = Array.from(new Set(trainings.map((t) => t.centerId)));
    const centers = await prisma.trainingCenter.findMany({
      where: { id: { in: centerIds } },
      select: {
        id: true,
        name: true,
        city: true,
        siren: true,
        siret: true,
        email: true,
        phone: true,
        website: true,
      },
    });
    const centerMap = new Map<number, CtrLite>();
    const cleanCenters = new Set<number>();
    centers.forEach((c) => {
      if (!options.cleanOnly || isCenterClean(c)) {
        cleanCenters.add(c.id);
      }
      centerMap.set(c.id, {
        id: c.id,
        name: c.name,
        city: c.city,
        postalCode: null,
        region: null,
        country: null,
        website: c.website,
        email: c.email,
        phone: c.phone,
      });
    });

    for (const t of trainings) {
      if (options.cleanOnly && !cleanCenters.has(t.centerId)) {
        continue;
      }
      const center = centerMap.get(t.centerId);
      const priceNum = toNumberSafe(t.priceValue);

      const row = ws.addRow({
        id: t.id,
        centerId: t.centerId,
        centerName: center?.name ?? "",
        centerCity: center?.city ?? "",
        title: t.title,
        modality: t.modality ?? "",
        certification: t.certification ?? "",
        locationText: t.locationText ?? "",
        region: t.region ?? "",
        priceText: t.priceText ?? "",
        priceValue: priceNum ?? "",
        durationText: t.durationText ?? "",
        durationHours: t.durationHours ?? "",
        startDate: t.startDate ?? "",
        endDate: t.endDate ?? "",
        searchQuery: t.searchQuery ?? "",
        detailUrl: t.detailUrl,
        lastListScrapedAt: t.lastListScrapedAt ?? "",
        lastDetailScrapedAt: t.lastDetailScrapedAt ?? "",
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        titleFilter: options.titleFilterMatches?.filter.raw ?? "",
      });

      const colIdx = (key: string) =>
        columns.findIndex((c) => c.key === key) + 1;

      if (priceNum != null) {
        const cell = row.getCell(colIdx("priceValue"));
        cell.numFmt = MONEY_FMT;
      }

      [
        "startDate",
        "endDate",
        "lastListScrapedAt",
        "lastDetailScrapedAt",
        "createdAt",
        "updatedAt",
      ].forEach((k) => {
        const cell = row.getCell(colIdx(k));
        if (cell.value) cell.numFmt = DATE_FMT;
      });

      if (t.detailUrl) {
        row.getCell(colIdx("detailUrl")).value = {
          text: t.detailUrl,
          hyperlink: t.detailUrl.startsWith("http")
            ? t.detailUrl
            : `https://${t.detailUrl}`,
        } as ExcelJS.CellHyperlinkValue;
      }

      row.commit();
      total++;
    }
  };

  if (effectiveMatchedTrainingIds) {
    const batches = chunkArray(effectiveMatchedTrainingIds, PAGE_SIZE);
    for (const batch of batches) {
      const trainings = await prisma.training.findMany({
        where: combineTrainingWhere([
          { id: { in: batch } },
          options.createdAfter
            ? { createdAt: { gte: options.createdAfter } }
            : undefined,
          options.cleanOnly
            ? { center: { is: buildCleanCenterWhere() } }
            : undefined,
          chunkCenterIds
            ? { centerId: { in: chunkCenterIds } }
            : undefined,
        ]),
        orderBy: { id: "asc" },
        select: {
          id: true,
          centerId: true,
          title: true,
          detailUrl: true,
          summary: true,
          modality: true,
          certification: true,
          locationText: true,
          region: true,
          priceText: true,
          priceValue: true,
          durationText: true,
          durationHours: true,
          startDate: true,
          endDate: true,
          searchQuery: true,
          lastListScrapedAt: true,
          lastDetailScrapedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (trainings.length === 0) continue;
      page += 1;
      await writeTrainingsBatch(trainings);
      logger.info?.(`Formations filtrées: page ${page}, cumul ${total}`);
    }
  } else if (chunkTrainingIds && chunkTrainingIds.length > 0) {
    const batches = chunkArray(chunkTrainingIds, PAGE_SIZE);
    for (const batch of batches) {
      const trainings = await prisma.training.findMany({
        where: combineTrainingWhere([
          { id: { in: batch } },
          options.createdAfter
            ? { createdAt: { gte: options.createdAfter } }
            : undefined,
          options.cleanOnly
            ? { center: { is: buildCleanCenterWhere() } }
            : undefined,
          chunkCenterIds
            ? { centerId: { in: chunkCenterIds } }
            : undefined,
        ]),
        orderBy: { id: "asc" },
        select: {
          id: true,
          centerId: true,
          title: true,
          detailUrl: true,
          summary: true,
          modality: true,
          certification: true,
          locationText: true,
          region: true,
          priceText: true,
          priceValue: true,
          durationText: true,
          durationHours: true,
          startDate: true,
          endDate: true,
          searchQuery: true,
          lastListScrapedAt: true,
          lastDetailScrapedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (trainings.length === 0) continue;
      page += 1;
      await writeTrainingsBatch(trainings);
      logger.info?.(`Formations chunk: page ${page}, cumul ${total}`);
    }
  } else {
    for (;;) {
      const where = combineTrainingWhere([
        options.createdAfter
          ? { createdAt: { gte: options.createdAfter } }
          : undefined,
        options.cleanOnly
          ? { center: { is: buildCleanCenterWhere() } }
          : undefined,
        lastId ? { id: { gt: lastId } } : undefined,
        chunkCenterIds
          ? { centerId: { in: chunkCenterIds } }
          : undefined,
        chunkTrainingIds
          ? { id: { in: chunkTrainingIds } }
          : undefined,
      ]);

      const trainings = await prisma.training.findMany({
        where,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        select: {
          id: true,
          centerId: true,
          title: true,
          detailUrl: true,
          summary: true,
          modality: true,
          certification: true,
          locationText: true,
          region: true,
          priceText: true,
          priceValue: true,
          durationText: true,
          durationHours: true,
          startDate: true,
          endDate: true,
          searchQuery: true,
          lastListScrapedAt: true,
          lastDetailScrapedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (trainings.length === 0) break;
      page += 1;
      await writeTrainingsBatch(trainings);

      lastId = trainings[trainings.length - 1].id;
      logger.info?.(`Formations: page ${page}, cumul ${total}`);
      if (trainings.length < PAGE_SIZE) break;
    }
  }

  ws.commit();
}

async function writeSummarySheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: SheetOptions = {}
) {
  const ws = workbook.addWorksheet("Résumé", {
    properties: { tabColor: { argb: "FF4BACC6" } },
    views: [{ state: "frozen", ySplit: 1 }],
  });

  // Headers
  ws.columns = [
    { header: "Région", key: "region", width: 24 },
    { header: "Centres (nb)", key: "centers", width: 14 },
    { header: "Formations (nb)", key: "trainings", width: 16 },
  ];
  ws.addRow(["Région", "Centres (nb)", "Formations (nb)"]).font = {
    bold: true,
  };

  // Aggregates
  const centerWhere: Prisma.TrainingCenterWhereInput | undefined =
    combineCenterWhere([
      options.cleanOnly ? buildCleanCenterWhere() : undefined,
      options.createdAfter
        ? { createdAt: { gte: options.createdAfter } }
        : undefined,
      options.titleFilterMatches
        ? { id: { in: options.titleFilterMatches.centerIds } }
        : undefined,
      options.centerIdFilter
        ? { id: { in: options.centerIdFilter } }
        : undefined,
    ]);
  const trainingWhere: Prisma.TrainingWhereInput | undefined =
    combineTrainingWhere([
      options.createdAfter
        ? { createdAt: { gte: options.createdAfter } }
        : undefined,
      options.cleanOnly
        ? { center: { is: buildCleanCenterWhere() } }
        : undefined,
      options.titleFilterMatches
        ? { id: { in: options.titleFilterMatches.trainingIds } }
        : undefined,
      options.centerIdFilter
        ? { centerId: { in: options.centerIdFilter } }
        : undefined,
      options.trainingIdsFilter
        ? { id: { in: options.trainingIdsFilter } }
        : undefined,
    ]);

  const centersByRegion = await prisma.trainingCenter.groupBy({
    by: ["region"],
    _count: { _all: true },
    ...(centerWhere ? { where: centerWhere } : {}),
  });

  const trainingsByRegion = await prisma.training.groupBy({
    by: ["region"],
    _count: { _all: true },
    ...(trainingWhere ? { where: trainingWhere } : {}),
  });

  const mapCenters = new Map<string | null, number>();
  const mapTrainings = new Map<string | null, number>();
  centersByRegion.forEach((r) =>
    mapCenters.set(r.region ?? null, r._count._all)
  );
  trainingsByRegion.forEach((r) =>
    mapTrainings.set(r.region ?? null, r._count._all)
  );

  const regions = new Set<string | null>([
    ...Array.from(mapCenters.keys()),
    ...Array.from(mapTrainings.keys()),
  ]);

  let totalCenters = 0;
  let totalTrainings = 0;

  for (const region of regions) {
    const c = mapCenters.get(region) ?? 0;
    const t = mapTrainings.get(region) ?? 0;
    totalCenters += c;
    totalTrainings += t;
    ws.addRow([region ?? "N/A", c, t]).commit?.();
  }

  // Totals
  const totalRow = ws.addRow(["TOTAL", totalCenters, totalTrainings]);
  totalRow.font = { bold: true };
  totalRow.commit?.();

  ws.commit();
}

// ------------------------- Main -------------------------

const buildBaseFileName = (titleFilter?: TitleFilter): string => {
  if (titleFilter) {
    return `export_cpf_${sanitizeForFilename(titleFilter.raw)}`;
  }
  return `export_mcf_${TIMESTAMP}`;
};

const buildChunkLabel = (centerIds: number[], index: number): string => {
  if (centerIds.length === 0) return `chunk-${index} (vide)`;
  if (centerIds.length === 1) {
    return `chunk-${index} (centre ${centerIds[0]})`;
  }
  const first = centerIds[0];
  const last = centerIds[centerIds.length - 1];
  return `chunk-${index} (centres ${first}-${last})`;
};

type FileAllocator = {
  registerFinalFile: (tempPath: string) => Promise<string>;
  getFiles: () => string[];
};

const createFileAllocator = (baseName: string): FileAllocator => {
  const files: string[] = [];
  let partMode = false;

  return {
    getFiles: () => [...files],
    async registerFinalFile(tempPath: string) {
      const nextIndex = files.length + 1;
      if (nextIndex === 1 && !partMode) {
        const targetPath = path.join(EXPORT_DIR, `${baseName}.xlsx`);
        await safeUnlink(targetPath);
        await fs.rename(tempPath, targetPath);
        files.push(targetPath);
        return targetPath;
      }

      if (!partMode) {
        partMode = true;
        const renamedFirst = path.join(EXPORT_DIR, `${baseName}_part1.xlsx`);
        await safeUnlink(renamedFirst);
        const previous = files[0];
        await fs.rename(previous, renamedFirst);
        files[0] = renamedFirst;
      }

      const targetPath = path.join(
        EXPORT_DIR,
        `${baseName}_part${nextIndex}.xlsx`
      );
      await safeUnlink(targetPath);
      await fs.rename(tempPath, targetPath);
      files.push(targetPath);
      return targetPath;
    },
  };
};

type ChunkJob = {
  centerIds: number[];
  trainingIds?: number[];
  label?: string;
};

type ChunkContext = {
  baseOptions: SheetOptions;
  includeTrainings: boolean;
  allocator: FileAllocator;
  baseFileName: string;
};

const writeWorkbookToPath = async (
  filename: string,
  sheetOptions: SheetOptions,
  includeTrainings: boolean
): Promise<void> => {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename,
    useStyles: true,
    useSharedStrings: true,
  });

  try {
    await writeCentersSheet(workbook, sheetOptions);
    if (includeTrainings) {
      await writeTrainingsSheet(workbook, sheetOptions);
    } else {
      logger.info?.("Export ⇒ feuille Formations ignorée (--centers-only)");
    }
    await writeSummarySheet(workbook, sheetOptions);
    await workbook.commit();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error?.(`Export Excel échoué: ${errorMessage}`);
    try {
      await workbook.commit();
    } catch (commitError) {
      logger.error?.(
        `Erreur lors de la fermeture du workbook: ${commitError instanceof Error ? commitError.message : String(commitError)}`
      );
    }
    throw error;
  }
};

const collectCenterIdsForExport = async (
  options: SheetOptions
): Promise<number[]> => {
  if (options.titleFilterMatches) {
    return options.titleFilterMatches.centerIds;
  }

  const ids: number[] = [];
  let lastId: number | undefined;
  for (;;) {
    const where = combineCenterWhere([
      options.cleanOnly ? buildCleanCenterWhere() : undefined,
      options.createdAfter
        ? { createdAt: { gte: options.createdAfter } }
        : undefined,
      lastId ? { id: { gt: lastId } } : undefined,
    ]);

    const centers = await prisma.trainingCenter.findMany({
      where,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });

    if (centers.length === 0) break;
    centers.forEach((c) => ids.push(c.id));
    lastId = centers[centers.length - 1].id;
    if (centers.length < PAGE_SIZE) break;
  }

  return ids;
};

const collectTrainingIdsForCenter = async (
  centerId: number,
  options: SheetOptions
): Promise<number[]> => {
  const ids: number[] = [];
  let lastId: number | undefined;

  for (;;) {
    const where = combineTrainingWhere([
      options.createdAfter
        ? { createdAt: { gte: options.createdAfter } }
        : undefined,
      options.cleanOnly
        ? { center: { is: buildCleanCenterWhere() } }
        : undefined,
      options.titleFilterMatches
        ? { id: { in: options.titleFilterMatches.trainingIds } }
        : undefined,
      { centerId },
      lastId ? { id: { gt: lastId } } : undefined,
    ]);

    const trainings = await prisma.training.findMany({
      where,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });

    if (trainings.length === 0) break;
    trainings.forEach((t) => ids.push(t.id));
    lastId = trainings[trainings.length - 1].id;
    if (trainings.length < PAGE_SIZE) break;
  }

  return ids;
};

const exportChunkJob = async (
  job: ChunkJob,
  ctx: ChunkContext
): Promise<void> => {
  const chunkOptions: SheetOptions = {
    ...ctx.baseOptions,
    centerIdFilter: job.centerIds,
    trainingIdsFilter: job.trainingIds,
  };

  const tempPath = createTempFilePath(ctx.baseFileName);
  await writeWorkbookToPath(tempPath, chunkOptions, ctx.includeTrainings);
  const stats = await fs.stat(tempPath);

  if (stats.size <= MAX_FILE_SIZE_BYTES) {
    const finalPath = await ctx.allocator.registerFinalFile(tempPath);
    logger.info?.(
      `Export ⇒ ${job.label ?? "chunk"} validé (${formatBytes(stats.size)}) -> ${finalPath}`
    );
    return;
  }

  await safeUnlink(tempPath);
  const readableSize = formatBytes(stats.size);
  logger.warn?.(
    `Export ⇒ ${job.label ?? "chunk"} trop volumineux (${readableSize}), division en cours`
  );

  if (job.trainingIds && job.trainingIds.length > 1) {
    const mid = Math.ceil(job.trainingIds.length / 2);
    await exportChunkJob(
      {
        centerIds: job.centerIds,
        trainingIds: job.trainingIds.slice(0, mid),
        label: `${job.label ?? "chunk"} (formations A)`,
      },
      ctx
    );
    await exportChunkJob(
      {
        centerIds: job.centerIds,
        trainingIds: job.trainingIds.slice(mid),
        label: `${job.label ?? "chunk"} (formations B)`,
      },
      ctx
    );
    return;
  }

  if (job.centerIds.length > 1) {
    const mid = Math.ceil(job.centerIds.length / 2);
    await exportChunkJob(
      {
        centerIds: job.centerIds.slice(0, mid),
        label: `${job.label ?? "chunk"} (part 1)`,
      },
      ctx
    );
    await exportChunkJob(
      {
        centerIds: job.centerIds.slice(mid),
        label: `${job.label ?? "chunk"} (part 2)`,
      },
      ctx
    );
    return;
  }

  if (!ctx.includeTrainings) {
    throw new Error(
      `Impossible de réduire davantage ${job.label ?? "le chunk"} sans formations`
    );
  }

  const centerId = job.centerIds[0];
  if (!centerId) {
    throw new Error("Chunk vide impossible à réduire davantage");
  }

  const allTrainingIds =
    job.trainingIds ??
    (await collectTrainingIdsForCenter(centerId, ctx.baseOptions));

  if (allTrainingIds.length <= 1) {
    throw new Error(
      `Impossible de générer un fichier < ${formatBytes(MAX_FILE_SIZE_BYTES)} pour le centre ${centerId}`
    );
  }

  const mid = Math.ceil(allTrainingIds.length / 2);
  await exportChunkJob(
    {
      centerIds: [centerId],
      trainingIds: allTrainingIds.slice(0, mid),
      label: `${job.label ?? `centre ${centerId}`} (formations 1)`,
    },
    ctx
  );
  await exportChunkJob(
    {
      centerIds: [centerId],
      trainingIds: allTrainingIds.slice(mid),
      label: `${job.label ?? `centre ${centerId}`} (formations 2)`,
    },
    ctx
  );
};

type ExportOptions = {
  includeTrainings?: boolean;
  createdAfter?: Date;
  cleanOnly?: boolean;
  titleFilter?: TitleFilter;
};

export async function exportToExcel(
  options: ExportOptions = {}
): Promise<string[]> {
  await ensureDir(EXPORT_DIR);

  let titleFilterMatches: TitleFilterMatches | undefined;
  if (options.titleFilter) {
    logger.info?.(
      `Export ⇒ préparation du filtre titre "${options.titleFilter.raw}"`
    );
    titleFilterMatches = await collectTitleFilterMatches(options.titleFilter, {
      createdAfter: options.createdAfter,
      cleanOnly: options.cleanOnly,
    });
    if (titleFilterMatches.trainingIds.length === 0) {
      logger.warn?.(
        `Export ⇒ aucun résultat pour le filtre titre "${options.titleFilter.raw}"`
      );
    } else {
      logger.info?.(
        `Export ⇒ filtre titre "${options.titleFilter.raw}" => ${titleFilterMatches.trainingIds.length} formations / ${titleFilterMatches.centerIds.length} centres`
      );
    }
  }

  const baseOptions: SheetOptions = {
    createdAfter: options.createdAfter,
    cleanOnly: options.cleanOnly,
    titleFilterMatches,
  };

  const includeTrainings = options.includeTrainings ?? true;
  const baseFileName = buildBaseFileName(options.titleFilter);
  const allocator = createFileAllocator(baseFileName);
  const centerIds = await collectCenterIdsForExport(baseOptions);

  logger.info?.(
    `Export ⇒ ${centerIds.length} centre(s) à exporter${includeTrainings ? "" : " (centres uniquement)"}`
  );

  const centerChunks =
    centerIds.length > 0
      ? chunkArray(centerIds, DEFAULT_CENTER_CHUNK_SIZE)
      : [[]];

  const ctx: ChunkContext = {
    baseOptions,
    includeTrainings,
    allocator,
    baseFileName,
  };

  let chunkIndex = 0;
  for (const chunk of centerChunks) {
    chunkIndex += 1;
    await exportChunkJob(
      {
        centerIds: chunk,
        label: buildChunkLabel(chunk, chunkIndex),
      },
      ctx
    );
  }

  const files = allocator.getFiles();
  if (files.length === 0) {
    throw new Error("Aucun fichier export généré");
  }

  logger.info?.(
    `Export ⇒ ${files.length} fichier(s) généré(s) (max ${formatBytes(MAX_FILE_SIZE_BYTES)} chacun)`
  );

  return files;
}

// Exécutable direct (ts-node src/scripts/export-excel.ts)
if (require.main === module) {
  const args = process.argv.slice(2);
  const centersOnly =
    args.includes("--centers-only") || args.includes("--centres-only");

  let createdAfter: Date | undefined;
  const directArg = args.find((arg) => arg.startsWith("--created-after="));
  if (directArg) {
    const value = directArg.split("=")[1];
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        createdAfter = parsed;
      } else {
        logger.error?.(`❌ Date invalide pour --created-after: ${value}`);
        process.exit(1);
      }
    }
  } else {
    const index = args.findIndex((arg) => arg === "--created-after");
    if (index !== -1) {
      const value = args[index + 1];
      if (!value) {
        logger.error?.("❌ Argument manquant après --created-after");
        process.exit(1);
      }
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        createdAfter = parsed;
      } else {
        logger.error?.(`❌ Date invalide pour --created-after: ${value}`);
        process.exit(1);
      }
    }
  }

  if (createdAfter) {
    logger.info?.(
      `Export ⇒ filtre createdAfter activé (${createdAfter.toISOString()})`
    );
  }

  const cleanOnly = args.includes("--clean") || args.includes("--clean-list");
  if (cleanOnly) {
    logger.info?.("Export ⇒ filtre clean-only activé");
  }

  let titleFilter: TitleFilter | undefined;
  const directTitleArg = args.find((arg) => arg.startsWith("--title="));
  if (directTitleArg) {
    const raw = directTitleArg.slice("--title=".length).trim();
    const built = buildTitleFilter(raw);
    if (!built) {
      logger.error?.("❌ Argument --title invalide (texte vide)");
      process.exit(1);
    }
    titleFilter = built;
  } else {
    const titleIndex = args.findIndex((arg) => arg === "--title");
    if (titleIndex !== -1) {
      const raw = args[titleIndex + 1];
      if (!raw) {
        logger.error?.("❌ Argument manquant après --title");
        process.exit(1);
      }
      const built = buildTitleFilter(raw);
      if (!built) {
        logger.error?.("❌ Argument --title invalide (texte vide)");
        process.exit(1);
      }
      titleFilter = built;
    }
  }

  if (titleFilter) {
    logger.info?.(`Export ⇒ filtre titre demandé: "${titleFilter.raw}"`);
  }

  exportToExcel({
    includeTrainings: !centersOnly,
    createdAfter,
    cleanOnly,
    titleFilter,
  })
    .then((files) => {
      files.forEach((file) =>
        logger.info?.(`✅ Export terminé -> ${file}`)
      );
      process.exit(0);
    })
    .catch((err) => {
      logger.error?.(`❌ Erreur export: ${err?.message || err}`);
      process.exit(1);
    });
}
