-- CreateEnum
CREATE TYPE "SpecFormat" AS ENUM ('YAML', 'JSON');

-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('PROPOSED', 'PUBLISHED');

-- CreateTable
CREATE TABLE "ApiVersion" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "versionLabel" TEXT NOT NULL,
    "originalContent" TEXT NOT NULL,
    "parsedContent" JSONB NOT NULL,
    "format" "SpecFormat" NOT NULL,
    "openApiVersion" TEXT NOT NULL,
    "status" "VersionStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiVersion_serviceId_versionLabel_key" ON "ApiVersion"("serviceId", "versionLabel");

-- AddForeignKey
ALTER TABLE "ApiVersion" ADD CONSTRAINT "ApiVersion_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
