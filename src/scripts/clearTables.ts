import { prisma } from "../db/prisma";

async function clearTables() {
  try {
    const { trainings, centers } = await prisma.$transaction(async (tx) => {
      const trainings = await tx.training.deleteMany();
      const centers = await tx.trainingCenter.deleteMany();

      return { trainings, centers };
    });

    console.log(`[DB] Suppression de ${trainings.count} formation.`);
    console.log(`[DB] Suppression de ${centers.count} centres de formation.`);
  } catch (error) {
    console.error("[DB] Erreur lors de la suppression des tables : ", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

clearTables();
