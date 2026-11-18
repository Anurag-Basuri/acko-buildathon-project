-- CreateEnum
CREATE TYPE "PublishOutcome" AS ENUM ('PUBLISHED', 'BLOCKED');

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "proposedVersionId" TEXT NOT NULL,
    "baselineVersionId" TEXT NOT NULL,
    "providerServiceId" TEXT NOT NULL,
    "dependencyFingerprint" TEXT NOT NULL,
    "specContentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "countsTotal" INTEGER NOT NULL,
    "countsBreaking" INTEGER NOT NULL,
    "countsNonBreaking" INTEGER NOT NULL,
    "countsUnknown" INTEGER NOT NULL,
    "affectedConsumerCount" INTEGER NOT NULL,
    "affectedDependencyCount" INTEGER NOT NULL,
    "affectedChangeCount" INTEGER NOT NULL,
    "classifiedChanges" JSONB NOT NULL,
    "impact" JSONB NOT NULL,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishAttempt" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "analysisRunId" TEXT,
    "outcome" "PublishOutcome" NOT NULL,
    "reason" TEXT NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "decisionDetails" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalysisRun_proposedVersionId_createdAt_idx" ON "AnalysisRun"("proposedVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_providerServiceId_createdAt_idx" ON "AnalysisRun"("providerServiceId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishAttempt_versionId_createdAt_idx" ON "PublishAttempt"("versionId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishAttempt_createdAt_idx" ON "PublishAttempt"("createdAt");

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_proposedVersionId_fkey" FOREIGN KEY ("proposedVersionId") REFERENCES "ApiVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_baselineVersionId_fkey" FOREIGN KEY ("baselineVersionId") REFERENCES "ApiVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_providerServiceId_fkey" FOREIGN KEY ("providerServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ApiVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
