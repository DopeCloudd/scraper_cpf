/* eslint-disable no-console */
import ExcelJS from "exceljs";
import fs from "fs/promises";
import path from "path";
import { prisma } from "../db/prisma";
import { logger } from "../utils/logger"; // si vous n'avez pas ce logger, remplacez par console

// ------------------------- Config export -------------------------
const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_PATH = path.join(EXPORT_DIR, `export_mcf_${TIMESTAMP}.xlsx`);
const PAGE_SIZE = Number(process.env.EXPORT_PAGE_SIZE ?? 1000); // pagination DB

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

// ------------------------- Sheets builders -------------------------

async function writeCentersSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter) {
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
  ];
  ws.columns = columns;
  ws.addRow(columns.map((c) => c.header)).font = { bold: true };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  // Precompute counts per center
  const counts = await prisma.training.groupBy({
    by: ["centerId"],
    _count: { _all: true },
  });
  const countMap = new Map<number, number>();
  counts.forEach((c) => countMap.set(c.centerId, c._count._all));

  // Stream centers by pages
  let lastId: number | undefined;
  let page = 0;
  let total = 0;

  for (;;) {
    const centers = await prisma.trainingCenter.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
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

    for (const c of centers) {
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
      });

      // formats
      const colIdx = (key: string) =>
        columns.findIndex((c) => c.key === key) + 1;

      // hyperlinks
      if (c.website) {
        row.getCell(colIdx("website")).value = {
          text: c.website,
          hyperlink: /^https?:\/\//i.test(c.website)
            ? c.website
            : `https://${c.website}`,
        } as ExcelJS.CellHyperlinkValue;
      }

      // dates formatting
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

    lastId = centers[centers.length - 1].id;
    logger.info?.(`Centres: page ${page}, cumul ${total}`);
    if (centers.length < PAGE_SIZE) break;
  }

  ws.commit();
}

async function writeTrainingsSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter
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
  ];
  ws.columns = columns;
  ws.addRow(columns.map((c) => c.header)).font = { bold: true };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  let lastId: number | undefined;
  let page = 0;
  let total = 0;

  for (;;) {
    const trainings = await prisma.training.findMany({
      where: lastId ? { id: { gt: lastId } } : {},
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

    // Fetch minimal centers for this batch
    const centerIds = Array.from(new Set(trainings.map((t) => t.centerId)));
    const centers = await prisma.trainingCenter.findMany({
      where: { id: { in: centerIds } },
      select: { id: true, name: true, city: true },
    });
    const centerMap = new Map<number, CtrLite>();
    centers.forEach((c) =>
      centerMap.set(c.id, {
        id: c.id,
        name: c.name,
        city: c.city,
        postalCode: null,
        region: null,
        country: null,
        website: null,
        email: null,
        phone: null,
      })
    );

    for (const t of trainings) {
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
      });

      // formats
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

      // hyperlink
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

    lastId = trainings[trainings.length - 1].id;
    logger.info?.(`Formations: page ${page}, cumul ${total}`);
    if (trainings.length < PAGE_SIZE) break;
  }

  ws.commit();
}

async function writeSummarySheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter) {
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
  const centersByRegion = await prisma.trainingCenter.groupBy({
    by: ["region"],
    _count: { _all: true },
  });

  const trainingsByRegion = await prisma.training.groupBy({
    by: ["region"],
    _count: { _all: true },
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

type ExportOptions = {
  includeTrainings?: boolean;
};

export async function exportToExcel(
  options: ExportOptions = {}
): Promise<string> {
  await ensureDir(EXPORT_DIR);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: OUTPUT_PATH,
    useStyles: true,
    useSharedStrings: true,
  });

  try {
    await writeCentersSheet(workbook);
    if (options.includeTrainings ?? true) {
      await writeTrainingsSheet(workbook);
    } else {
      logger.info?.("Export ⇒ feuille Formations ignorée (--centers-only)");
    }
    await writeSummarySheet(workbook);

    await workbook.commit();
    logger.info?.(`Export Excel écrit: ${OUTPUT_PATH}`);
    return OUTPUT_PATH;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logger.error?.(`Export Excel échoué: ${errorMessage}`);
    // important: close writer properly
    try {
      await workbook.commit();
    } catch (commitError) {
      logger.error?.(
        `Erreur lors de la fermeture du workbook: ${commitError instanceof Error ? commitError.message : String(commitError)}`
      );
    }
    throw e;
  } finally {
    // pas de prisma.$disconnect() ici pour laisser l'app gérer son cycle
  }
}

// Exécutable direct (ts-node src/scripts/export-excel.ts)
if (require.main === module) {
  const args = process.argv.slice(2);
  const centersOnly =
    args.includes("--centers-only") || args.includes("--centres-only");

  exportToExcel({ includeTrainings: !centersOnly })
    .then((file) => {
      logger.info?.(`✅ Export terminé -> ${file}`);
      process.exit(0);
    })
    .catch((err) => {
      logger.error?.(`❌ Erreur export: ${err?.message || err}`);
      process.exit(1);
    });
}
