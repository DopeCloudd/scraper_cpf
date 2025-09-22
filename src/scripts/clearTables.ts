import { prisma } from '../db/prisma';

async function clearTables() {
  try {
    const { trainings, centers } = await prisma.$transaction(async (tx) => {
      const trainings = await tx.training.deleteMany();
      const centers = await tx.trainingCenter.deleteMany();

      return { trainings, centers };
    });

    console.log(`Deleted ${trainings.count} trainings.`);
    console.log(`Deleted ${centers.count} training centers.`);
  } catch (error) {
    console.error('Failed to clear tables:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

clearTables();
